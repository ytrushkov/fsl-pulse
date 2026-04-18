import type { Dimension } from "./rubric";
import { assertSafeUrlResolved } from "./util";
import { logger } from "./logger";

/**
 * Per-request context passed into connector calls so subcall-level logging
 * can be correlated with the originating API call. Routes pass `req.id`
 * here; the connector emits start/end log lines tagged with that id.
 */
export type ConnectorCtx = { requestId?: string };

// Defense-in-depth: even though connector create/patch validates baseUrl
// syntactically, we re-check at fetch time *and* resolve DNS so an
// attacker-controlled hostname that points at 169.254.169.254 / RFC1918 is
// rejected before fetch().
async function assertSafeUrl(url: string): Promise<void> {
  await assertSafeUrlResolved(url);
}

export interface ConnectorVerifyResult {
  ok: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

export interface CollectedEvidence {
  dimension: Dimension;
  signalType: "strength" | "gap" | "risk" | "quote";
  stageHint?: number | null;
  text: string;
}

export interface ConnectorRunResult {
  recordsCollected: number;
  summary: Record<string, unknown>;
  evidence: CollectedEvidence[];
}

async function ghFetch<T>(token: string, url: string): Promise<T> {
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "pulse-assessor",
    },
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${await r.text()}`);
  return (await r.json()) as T;
}

async function verifyGithub(
  token: string,
  config: Record<string, unknown>,
): Promise<ConnectorVerifyResult> {
  if (!token) return { ok: false, message: "Token required" };
  try {
    const me = await ghFetch<{ login: string }>(token, "https://api.github.com/user");
    const org = String(config.org ?? "");
    if (org) {
      try {
        await ghFetch<unknown>(token, `https://api.github.com/orgs/${org}`);
      } catch {
        return {
          ok: false,
          message: `Authenticated as ${me.login}, but cannot access org "${org}"`,
        };
      }
    }
    return { ok: true, message: `Authenticated as ${me.login}`, details: { login: me.login } };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Verify failed" };
  }
}

async function runGithub(
  token: string,
  config: Record<string, unknown>,
): Promise<ConnectorRunResult> {
  const org = String(config.org ?? "");
  const evidence: CollectedEvidence[] = [];
  let recordsCollected = 0;
  const summary: Record<string, unknown> = {};

  if (!org) {
    return {
      recordsCollected: 0,
      summary: { error: "No org configured" },
      evidence: [
        {
          dimension: "tooling",
          signalType: "gap",
          text: "GitHub connector configured but no org specified",
        },
      ],
    };
  }
  const repos = await ghFetch<Array<{ name: string; default_branch: string; pushed_at: string }>>(
    token,
    `https://api.github.com/orgs/${org}/repos?per_page=30&sort=pushed`,
  );
  recordsCollected += repos.length;
  summary.repoCount = repos.length;

  // Look for AI-related workflows
  let aiWorkflowRepos = 0;
  let totalWorkflowRepos = 0;
  for (const r of repos.slice(0, 10)) {
    try {
      const wf = await ghFetch<{ workflows: Array<{ name: string; path: string }> }>(
        token,
        `https://api.github.com/repos/${org}/${r.name}/actions/workflows`,
      );
      if (wf.workflows.length > 0) totalWorkflowRepos += 1;
      if (
        wf.workflows.some((w) =>
          /\b(copilot|cursor|claude|openai|llm|ai|cody|codeium)\b/i.test(`${w.name} ${w.path}`),
        )
      ) {
        aiWorkflowRepos += 1;
      }
      recordsCollected += wf.workflows.length;
    } catch {
      // skip repos we can't access
    }
  }
  summary.aiWorkflowRepos = aiWorkflowRepos;
  summary.workflowRepos = totalWorkflowRepos;

  if (aiWorkflowRepos > 0) {
    evidence.push({
      dimension: "tooling",
      signalType: "strength",
      stageHint: aiWorkflowRepos >= 3 ? 4 : 3,
      text: `Detected AI-related GitHub Actions workflows in ${aiWorkflowRepos} of ${Math.min(repos.length, 10)} sampled repos.`,
    });
  } else if (totalWorkflowRepos > 0) {
    evidence.push({
      dimension: "tooling",
      signalType: "gap",
      stageHint: 2,
      text: `${totalWorkflowRepos} repos have CI workflows but none reference AI tools.`,
    });
  }

  // ---- DORA-style normalized signals ----------------------------------
  // We sample up to 5 repos and a 30-day window to keep runs cheap. Each
  // metric gets its own evidence row tagged to the right dimension so the
  // scoring engine can pick them up consistently across providers.
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  let workflowRunsTotal = 0;
  let workflowRunsFailed = 0;
  let workflowRunsSucceeded = 0;
  let prsSampled = 0;
  let prsMerged = 0;
  let prLeadTimeSumMs = 0;
  let prLeadTimeCount = 0;
  let prsWithReviews = 0;

  for (const r of repos.slice(0, 5)) {
    try {
      // Workflow runs in the last 30 days → deployment frequency proxy +
      // change-failure-rate proxy. We use `created` as an upper bound on
      // both so the same call serves both metrics.
      const wfr = await ghFetch<{
        total_count: number;
        workflow_runs: Array<{ conclusion: string | null; created_at: string }>;
      }>(
        token,
        `https://api.github.com/repos/${org}/${r.name}/actions/runs?per_page=100&created=>=${since}`,
      );
      workflowRunsTotal += wfr.workflow_runs.length;
      workflowRunsSucceeded += wfr.workflow_runs.filter(
        (w) => w.conclusion === "success",
      ).length;
      workflowRunsFailed += wfr.workflow_runs.filter(
        (w) => w.conclusion === "failure",
      ).length;
      recordsCollected += wfr.workflow_runs.length;
    } catch {
      // ignore — repo may not have Actions enabled
    }
    try {
      const prs = await ghFetch<
        Array<{
          number: number;
          merged_at: string | null;
          created_at: string;
          requested_reviewers?: unknown[];
        }>
      >(
        token,
        `https://api.github.com/repos/${org}/${r.name}/pulls?state=closed&per_page=30`,
      );
      prsSampled += prs.length;
      for (const p of prs) {
        if (p.merged_at) {
          prsMerged += 1;
          const lead =
            new Date(p.merged_at).getTime() - new Date(p.created_at).getTime();
          if (lead > 0) {
            prLeadTimeSumMs += lead;
            prLeadTimeCount += 1;
          }
        }
        // Get review count for this PR (one call per PR is too many; sample
        // by checking requested_reviewers presence as a cheap proxy for
        // "code review automation/process is in place").
        if (
          Array.isArray(p.requested_reviewers) &&
          p.requested_reviewers.length > 0
        ) {
          prsWithReviews += 1;
        }
      }
    } catch {
      // ignore
    }
  }

  // Deployment frequency (workflow runs / day, last 30 days) — proxy for
  // DORA "deployment frequency" since CI runs are the closest universal
  // signal we have without per-repo deploy-environment config.
  const deploysPerDay = workflowRunsTotal / 30;
  summary.workflowRuns30d = workflowRunsTotal;
  summary.workflowRunsSucceeded30d = workflowRunsSucceeded;
  summary.workflowRunsFailed30d = workflowRunsFailed;
  summary.deploysPerDay = Number(deploysPerDay.toFixed(2));
  if (workflowRunsTotal > 0) {
    evidence.push({
      dimension: "process",
      signalType: deploysPerDay >= 1 ? "strength" : "gap",
      stageHint: deploysPerDay >= 5 ? 5 : deploysPerDay >= 1 ? 4 : 2,
      text: `Deployment frequency proxy: ~${deploysPerDay.toFixed(2)} CI runs/day across sampled repos (30d).`,
    });
  }

  // Change failure rate — failed runs / total runs. Industry "elite" ~0–15%.
  if (workflowRunsTotal > 0) {
    const cfr = workflowRunsFailed / workflowRunsTotal;
    summary.changeFailureRate = Number(cfr.toFixed(3));
    evidence.push({
      dimension: "measurement",
      signalType: cfr <= 0.15 ? "strength" : "gap",
      stageHint: cfr <= 0.15 ? 4 : cfr <= 0.3 ? 3 : 2,
      text: `Change failure rate proxy: ${(cfr * 100).toFixed(1)}% (${workflowRunsFailed}/${workflowRunsTotal} CI runs failed, 30d).`,
    });
  }

  // Lead time for changes — median PR created→merged across the sample.
  if (prLeadTimeCount > 0) {
    const avgHours = prLeadTimeSumMs / prLeadTimeCount / 3_600_000;
    summary.leadTimeHoursAvg = Number(avgHours.toFixed(1));
    evidence.push({
      dimension: "process",
      signalType: avgHours <= 48 ? "strength" : "gap",
      stageHint: avgHours <= 24 ? 5 : avgHours <= 48 ? 4 : avgHours <= 168 ? 3 : 2,
      text: `Lead time for changes: avg ${avgHours.toFixed(1)} hours from PR open to merge (n=${prLeadTimeCount}).`,
    });
  }

  // Code-review automation / process — share of merged PRs that had at
  // least one requested reviewer.
  if (prsMerged > 0) {
    const reviewRate = prsWithReviews / prsMerged;
    summary.prReviewRate = Number(reviewRate.toFixed(2));
    evidence.push({
      dimension: "process",
      signalType: reviewRate >= 0.7 ? "strength" : "gap",
      stageHint: reviewRate >= 0.9 ? 5 : reviewRate >= 0.7 ? 4 : 2,
      text: `Code review automation: ${(reviewRate * 100).toFixed(0)}% of merged PRs had requested reviewers (n=${prsMerged}).`,
    });
  }
  summary.prsSampled = prsSampled;
  summary.prsMerged = prsMerged;

  return { recordsCollected, summary, evidence };
}

async function verifyGitlab(
  token: string,
  config: Record<string, unknown>,
): Promise<ConnectorVerifyResult> {
  if (!token) return { ok: false, message: "Token required" };
  const baseUrl = String(config.baseUrl ?? "https://gitlab.com").replace(/\/$/, "");
  try {
    await assertSafeUrl(baseUrl);
    // 1. baseUrl reachable + credentials valid (GET /user).
    const r = await fetch(`${baseUrl}/api/v4/user`, { headers: { "PRIVATE-TOKEN": token } });
    if (!r.ok) throw new Error(`GitLab auth ${r.status}`);
    const me = (await r.json()) as { username: string };
    // 2. If a group is configured, confirm the credential can actually see it
    //    — otherwise verify would falsely report green for a token that has no
    //    access to the data we need to collect.
    const group = String(config.group ?? "");
    if (group) {
      const gr = await fetch(
        `${baseUrl}/api/v4/groups/${encodeURIComponent(group)}`,
        { headers: { "PRIVATE-TOKEN": token } },
      );
      if (!gr.ok) {
        return {
          ok: false,
          message: `Authenticated as ${me.username}, but cannot access group "${group}" (HTTP ${gr.status})`,
        };
      }
    }
    return { ok: true, message: `Authenticated as ${me.username}`, details: { username: me.username, group } };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Verify failed" };
  }
}

async function runGitlab(
  token: string,
  config: Record<string, unknown>,
): Promise<ConnectorRunResult> {
  const baseUrl = String(config.baseUrl ?? "https://gitlab.com").replace(/\/$/, "");
  await assertSafeUrl(baseUrl);
  const group = String(config.group ?? "");
  const evidence: CollectedEvidence[] = [];
  if (!group)
    return { recordsCollected: 0, summary: { error: "No group configured" }, evidence };
  const headers = { "PRIVATE-TOKEN": token };
  const r = await fetch(
    `${baseUrl}/api/v4/groups/${encodeURIComponent(group)}/projects?per_page=30`,
    { headers },
  );
  if (!r.ok) throw new Error(`GitLab ${r.status}`);
  const projects = (await r.json()) as Array<{ name: string; id: number }>;
  evidence.push({
    dimension: "tooling",
    signalType: "strength",
    stageHint: 3,
    text: `Discovered ${projects.length} GitLab projects in group ${group}.`,
  });

  // ---- DORA-style normalized signals (sample up to 5 projects, 30d) ---
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  let pipelinesTotal = 0;
  let pipelinesFailed = 0;
  let mrsMerged = 0;
  let mrLeadSumMs = 0;
  let mrLeadCount = 0;
  let recordsCollected = projects.length;

  for (const p of projects.slice(0, 5)) {
    try {
      const pl = await fetch(
        `${baseUrl}/api/v4/projects/${p.id}/pipelines?updated_after=${since}&per_page=100`,
        { headers },
      );
      if (pl.ok) {
        const rows = (await pl.json()) as Array<{ status: string }>;
        pipelinesTotal += rows.length;
        pipelinesFailed += rows.filter((x) => x.status === "failed").length;
        recordsCollected += rows.length;
      }
    } catch {
      // ignore — project may have pipelines disabled
    }
    try {
      const mr = await fetch(
        `${baseUrl}/api/v4/projects/${p.id}/merge_requests?state=merged&updated_after=${since}&per_page=30`,
        { headers },
      );
      if (mr.ok) {
        const rows = (await mr.json()) as Array<{
          created_at: string;
          merged_at: string | null;
        }>;
        for (const m of rows) {
          if (m.merged_at) {
            mrsMerged += 1;
            const lead =
              new Date(m.merged_at).getTime() - new Date(m.created_at).getTime();
            if (lead > 0) {
              mrLeadSumMs += lead;
              mrLeadCount += 1;
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  const summary: Record<string, unknown> = {
    projectCount: projects.length,
    pipelines30d: pipelinesTotal,
    pipelinesFailed30d: pipelinesFailed,
    mrsMerged30d: mrsMerged,
  };

  if (pipelinesTotal > 0) {
    const deploysPerDay = pipelinesTotal / 30;
    summary.deploysPerDay = Number(deploysPerDay.toFixed(2));
    evidence.push({
      dimension: "process",
      signalType: deploysPerDay >= 1 ? "strength" : "gap",
      stageHint: deploysPerDay >= 5 ? 5 : deploysPerDay >= 1 ? 4 : 2,
      text: `Deployment frequency proxy: ~${deploysPerDay.toFixed(2)} pipelines/day across sampled GitLab projects (30d).`,
    });
    const cfr = pipelinesFailed / pipelinesTotal;
    summary.changeFailureRate = Number(cfr.toFixed(3));
    evidence.push({
      dimension: "measurement",
      signalType: cfr <= 0.15 ? "strength" : "gap",
      stageHint: cfr <= 0.15 ? 4 : cfr <= 0.3 ? 3 : 2,
      text: `Change failure rate proxy: ${(cfr * 100).toFixed(1)}% of GitLab pipelines failed (${pipelinesFailed}/${pipelinesTotal}, 30d).`,
    });
  }
  if (mrLeadCount > 0) {
    const avgHours = mrLeadSumMs / mrLeadCount / 3_600_000;
    summary.leadTimeHoursAvg = Number(avgHours.toFixed(1));
    evidence.push({
      dimension: "process",
      signalType: avgHours <= 48 ? "strength" : "gap",
      stageHint: avgHours <= 24 ? 5 : avgHours <= 48 ? 4 : avgHours <= 168 ? 3 : 2,
      text: `Lead time for changes: avg ${avgHours.toFixed(1)} hours from MR open to merge (n=${mrLeadCount}).`,
    });
  }

  return { recordsCollected, summary, evidence };
}

async function verifyJira(
  token: string,
  config: Record<string, unknown>,
): Promise<ConnectorVerifyResult> {
  if (!token) return { ok: false, message: "Token required" };
  const baseUrl = String(config.baseUrl ?? "").replace(/\/$/, "");
  const email = String(config.email ?? "");
  if (!baseUrl || !email)
    return { ok: false, message: "baseUrl and email required in config" };
  try {
    await assertSafeUrl(baseUrl);
    const auth = Buffer.from(`${email}:${token}`).toString("base64");
    const headers = { Authorization: `Basic ${auth}`, Accept: "application/json" };
    // 1. baseUrl reachable + credentials valid (GET /myself).
    const r = await fetch(`${baseUrl}/rest/api/3/myself`, { headers });
    if (!r.ok) throw new Error(`Jira auth ${r.status}`);
    const me = (await r.json()) as { displayName: string };
    // 2. If a project key is configured, confirm the credential can read it.
    const project = String(config.project ?? "");
    if (project) {
      const pr = await fetch(
        `${baseUrl}/rest/api/3/project/${encodeURIComponent(project)}`,
        { headers },
      );
      if (!pr.ok) {
        return {
          ok: false,
          message: `Authenticated as ${me.displayName}, but cannot access project "${project}" (HTTP ${pr.status})`,
        };
      }
    }
    return {
      ok: true,
      message: `Authenticated as ${me.displayName}`,
      details: { displayName: me.displayName, project },
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Verify failed" };
  }
}

async function runJira(
  token: string,
  config: Record<string, unknown>,
): Promise<ConnectorRunResult> {
  const baseUrl = String(config.baseUrl ?? "").replace(/\/$/, "");
  const email = String(config.email ?? "");
  const project = String(config.project ?? "");
  if (!baseUrl || !email)
    return { recordsCollected: 0, summary: {}, evidence: [] };
  await assertSafeUrl(baseUrl);
  const auth = Buffer.from(`${email}:${token}`).toString("base64");
  const headers = { Authorization: `Basic ${auth}`, Accept: "application/json" };
  const projClause = project ? `project=${project} AND ` : "";

  // 1. Recently-resolved tickets — for cycle/lead-time and MTTR proxy.
  const resolvedJql = `${projClause}resolved >= -30d ORDER BY resolved DESC`;
  const r = await fetch(
    `${baseUrl}/rest/api/3/search?jql=${encodeURIComponent(resolvedJql)}&fields=created,resolutiondate,labels,issuetype&maxResults=100`,
    { headers },
  );
  if (!r.ok) throw new Error(`Jira ${r.status}`);
  const data = (await r.json()) as {
    total: number;
    issues: Array<{
      fields: {
        created: string;
        resolutiondate: string | null;
        labels?: string[];
        issuetype?: { name: string };
      };
    }>;
  };

  const evidence: CollectedEvidence[] = [];
  evidence.push({
    dimension: "process",
    signalType: "strength",
    stageHint: 2,
    text: `Jira project has ${data.total} resolved issues in the last 30 days — active planning process.`,
  });

  // Cycle time (created → resolved) across all resolved tickets.
  let cycleSumMs = 0;
  let cycleCount = 0;
  // MTTR proxy: tickets whose type or labels suggest "incident" / "bug"
  // (resolved − created). Industry-standard mapping for orgs that don't have
  // a separate incident system.
  let mttrSumMs = 0;
  let mttrCount = 0;
  const isIncident = (i: (typeof data.issues)[number]) => {
    const type = i.fields.issuetype?.name?.toLowerCase() ?? "";
    const labels = (i.fields.labels ?? []).map((l) => l.toLowerCase());
    return (
      type === "incident" ||
      type === "bug" ||
      labels.includes("incident") ||
      labels.includes("outage") ||
      labels.includes("p0") ||
      labels.includes("p1")
    );
  };
  for (const issue of data.issues) {
    if (!issue.fields.resolutiondate) continue;
    const dur =
      new Date(issue.fields.resolutiondate).getTime() -
      new Date(issue.fields.created).getTime();
    if (dur <= 0) continue;
    cycleSumMs += dur;
    cycleCount += 1;
    if (isIncident(issue)) {
      mttrSumMs += dur;
      mttrCount += 1;
    }
  }

  const summary: Record<string, unknown> = {
    totalIssues: data.total,
    sampleSize: data.issues.length,
    resolved30d: cycleCount,
  };

  if (cycleCount > 0) {
    const avgHours = cycleSumMs / cycleCount / 3_600_000;
    summary.cycleTimeHoursAvg = Number(avgHours.toFixed(1));
    evidence.push({
      dimension: "process",
      signalType: avgHours <= 72 ? "strength" : "gap",
      stageHint: avgHours <= 24 ? 5 : avgHours <= 72 ? 4 : avgHours <= 240 ? 3 : 2,
      text: `Lead time (Jira): avg ${avgHours.toFixed(1)} hours from create to resolve (n=${cycleCount}, 30d).`,
    });
  }
  if (mttrCount > 0) {
    const mttrHours = mttrSumMs / mttrCount / 3_600_000;
    summary.mttrHoursAvg = Number(mttrHours.toFixed(1));
    summary.incidentTickets30d = mttrCount;
    evidence.push({
      dimension: "measurement",
      signalType: mttrHours <= 24 ? "strength" : "gap",
      stageHint: mttrHours <= 4 ? 5 : mttrHours <= 24 ? 4 : mttrHours <= 72 ? 3 : 2,
      text: `MTTR proxy: avg ${mttrHours.toFixed(1)} hours to resolve incident/bug tickets (n=${mttrCount}, 30d).`,
    });
  } else {
    summary.mttrHoursAvg = null;
    evidence.push({
      dimension: "measurement",
      signalType: "gap",
      stageHint: 1,
      text: "No incident-labeled tickets found in the last 30 days — MTTR cannot be measured. Tag incidents with 'incident', 'outage', 'p0', or 'p1' to enable measurement.",
    });
  }

  return {
    recordsCollected: data.issues.length,
    summary,
    evidence,
  };
}

async function verifyLinear(
  token: string,
  config: Record<string, unknown> = {},
): Promise<ConnectorVerifyResult> {
  if (!token) return { ok: false, message: "Token required" };
  try {
    // Combined query: viewer (auth check) + teams (workspace membership +
    // optional team-key access check). Linear has no separate base URL; the
    // GraphQL endpoint is fixed.
    const r = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({
        query:
          "{ viewer { name email } teams(first: 50) { nodes { id key name } } }",
      }),
    });
    if (!r.ok) throw new Error(`Linear ${r.status}`);
    const data = (await r.json()) as {
      data?: {
        viewer?: { name: string };
        teams?: { nodes: Array<{ id: string; key: string; name: string }> };
      };
      errors?: Array<{ message: string }>;
    };
    if (data.errors?.length) throw new Error(data.errors[0]!.message);
    if (!data.data?.viewer) throw new Error("Invalid response");
    const teams = data.data.teams?.nodes ?? [];
    const teamKey = String(config.teamKey ?? "").toUpperCase();
    if (teamKey) {
      const found = teams.some((t) => t.key.toUpperCase() === teamKey);
      if (!found) {
        return {
          ok: false,
          message: `Authenticated as ${data.data.viewer.name}, but no team with key "${teamKey}" is visible (saw ${teams.length} teams).`,
        };
      }
    }
    return {
      ok: true,
      message: `Authenticated as ${data.data.viewer.name}`,
      details: { name: data.data.viewer.name, teams: teams.length },
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Verify failed" };
  }
}

async function runLinear(token: string): Promise<ConnectorRunResult> {
  // Pull issues completed in the last 30 days with timestamps and labels so
  // we can compute cycle time and an MTTR proxy from incident-tagged issues.
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const r = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({
      query: `query($since: DateTimeOrDuration!) {
        teams { nodes { id name } }
        issues(first: 100, filter: { completedAt: { gte: $since } }) {
          nodes {
            id
            createdAt
            completedAt
            labels { nodes { name } }
          }
        }
      }`,
      variables: { since },
    }),
  });
  if (!r.ok) throw new Error(`Linear ${r.status}`);
  const data = (await r.json()) as {
    data?: {
      teams: { nodes: Array<{ id: string; name: string }> };
      issues: {
        nodes: Array<{
          id: string;
          createdAt: string;
          completedAt: string | null;
          labels: { nodes: Array<{ name: string }> };
        }>;
      };
    };
    errors?: Array<{ message: string }>;
  };
  if (data.errors?.length) throw new Error(data.errors[0]!.message);
  if (!data.data) throw new Error("Linear: empty response");

  const teams = data.data.teams.nodes.length;
  const issues = data.data.issues.nodes;
  let cycleSumMs = 0;
  let cycleCount = 0;
  let mttrSumMs = 0;
  let mttrCount = 0;

  for (const i of issues) {
    if (!i.completedAt) continue;
    const dur =
      new Date(i.completedAt).getTime() - new Date(i.createdAt).getTime();
    if (dur <= 0) continue;
    cycleSumMs += dur;
    cycleCount += 1;
    const labels = i.labels.nodes.map((l) => l.name.toLowerCase());
    if (
      labels.includes("incident") ||
      labels.includes("outage") ||
      labels.includes("p0") ||
      labels.includes("p1")
    ) {
      mttrSumMs += dur;
      mttrCount += 1;
    }
  }

  const evidence: CollectedEvidence[] = [
    {
      dimension: "tooling",
      signalType: "strength",
      stageHint: 3,
      text: `Linear: ${teams} teams visible, ${issues.length} issues completed in the last 30 days.`,
    },
  ];
  const summary: Record<string, unknown> = {
    teams,
    issuesCompleted30d: issues.length,
  };

  if (cycleCount > 0) {
    const avgHours = cycleSumMs / cycleCount / 3_600_000;
    summary.cycleTimeHoursAvg = Number(avgHours.toFixed(1));
    evidence.push({
      dimension: "process",
      signalType: avgHours <= 72 ? "strength" : "gap",
      stageHint: avgHours <= 24 ? 5 : avgHours <= 72 ? 4 : avgHours <= 240 ? 3 : 2,
      text: `Lead time (Linear): avg ${avgHours.toFixed(1)} hours from create to complete (n=${cycleCount}, 30d).`,
    });
  }
  if (mttrCount > 0) {
    const mttrHours = mttrSumMs / mttrCount / 3_600_000;
    summary.mttrHoursAvg = Number(mttrHours.toFixed(1));
    evidence.push({
      dimension: "measurement",
      signalType: mttrHours <= 24 ? "strength" : "gap",
      stageHint: mttrHours <= 4 ? 5 : mttrHours <= 24 ? 4 : mttrHours <= 72 ? 3 : 2,
      text: `MTTR proxy (Linear): avg ${mttrHours.toFixed(1)} hours to resolve incident-tagged issues (n=${mttrCount}, 30d).`,
    });
  }

  return {
    recordsCollected: teams + issues.length,
    summary,
    evidence,
  };
}

async function verifyCicd(
  token: string,
  config: Record<string, unknown>,
): Promise<ConnectorVerifyResult> {
  const provider = String(config.provider ?? "github_actions");
  if (provider === "github_actions") return verifyGithub(token, config);
  if (provider === "circleci") {
    if (!token) return { ok: false, message: "Token required" };
    const r = await fetch("https://circleci.com/api/v2/me", {
      headers: { "Circle-Token": token },
    });
    return r.ok ? { ok: true, message: "CircleCI authenticated" } : { ok: false, message: `CircleCI ${r.status}` };
  }
  return { ok: false, message: `Unknown CI/CD provider: ${provider}` };
}

async function runCicd(
  token: string,
  config: Record<string, unknown>,
): Promise<ConnectorRunResult> {
  const provider = String(config.provider ?? "github_actions");
  if (provider === "github_actions") {
    const out = await runGithub(token, config);
    out.evidence.push({
      dimension: "process",
      signalType: "strength",
      stageHint: 3,
      text: "CI/CD pipeline (GitHub Actions) actively in use.",
    });
    return out;
  }
  // Other CI providers (CircleCI, Jenkins, GitLab CI) are recognized but
  // collection is currently limited — surface the gap explicitly so the
  // assessor knows the dimension is uncovered rather than silently empty.
  return {
    recordsCollected: 0,
    summary: { provider, deploysPerDay: null, changeFailureRate: null },
    evidence: [
      {
        dimension: "process",
        signalType: "gap",
        stageHint: 1,
        text: `CI/CD connector configured for ${provider}, but automated metric collection (deploys/day, change-failure rate) is not yet implemented for this provider. Add a GitHub or GitLab connector for full DORA coverage.`,
      },
    ],
  };
}

async function verifyAiTooling(
  token: string,
  config: Record<string, unknown>,
): Promise<ConnectorVerifyResult> {
  const provider = String(config.provider ?? "openai");
  if (!token) return { ok: false, message: "Token required" };
  if (provider === "openai") {
    const r = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${token}` },
    });
    return r.ok
      ? { ok: true, message: "OpenAI authenticated" }
      : { ok: false, message: `OpenAI ${r.status}` };
  }
  if (provider === "anthropic") {
    const r = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": token, "anthropic-version": "2023-06-01" },
    });
    return r.ok
      ? { ok: true, message: "Anthropic authenticated" }
      : { ok: false, message: `Anthropic ${r.status}` };
  }
  return { ok: true, message: `Token recorded for ${provider} (no live verify available)` };
}

async function runAiTooling(
  token: string,
  config: Record<string, unknown>,
): Promise<ConnectorRunResult> {
  const provider = String(config.provider ?? "openai");
  let modelCount = 0;
  if (provider === "openai") {
    const r = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.ok) {
      const data = (await r.json()) as { data: unknown[] };
      modelCount = data.data.length;
    }
  } else if (provider === "anthropic") {
    const r = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": token, "anthropic-version": "2023-06-01" },
    });
    if (r.ok) {
      const data = (await r.json()) as { data: unknown[] };
      modelCount = data.data.length;
    }
  }
  // Adoption rate is genuinely hard to extract per-provider without per-user
  // usage APIs (which most don't expose). We surface the integration as
  // evidence of "AI tooling is in place" (tooling dimension) and explicitly
  // call out the adoption-measurement gap (people dimension) so the scoring
  // engine doesn't over-credit the org for merely having a key.
  const evidence: CollectedEvidence[] = [
    {
      dimension: "tooling",
      signalType: modelCount > 0 ? "strength" : "gap",
      stageHint: modelCount > 0 ? 3 : 2,
      text: `AI tooling provider "${provider}" configured with ${modelCount} models accessible.`,
    },
    {
      dimension: "people",
      signalType: "gap",
      stageHint: 2,
      text: `AI tool adoption rate (active users / engineers) cannot be measured automatically for ${provider} — pair this connector with the adoption-survey module to capture it.`,
    },
  ];
  return {
    recordsCollected: modelCount,
    summary: {
      provider,
      modelsAvailable: modelCount,
      adoptionRatePctApprox: null,
    },
    evidence,
  };
}

export async function verifyConnector(
  kind: string,
  provider: string,
  token: string,
  config: Record<string, unknown>,
  ctx: ConnectorCtx = {},
): Promise<ConnectorVerifyResult> {
  const cfg = { ...config, provider };
  const child = logger.child({ requestId: ctx.requestId, op: "verifyConnector", kind, provider });
  child.info("connector verify start");
  try {
    let result: ConnectorVerifyResult;
    switch (kind) {
      case "github":
        result = await verifyGithub(token, cfg);
        break;
      case "gitlab":
        result = await verifyGitlab(token, cfg);
        break;
      case "jira":
        result = await verifyJira(token, cfg);
        break;
      case "linear":
        result = await verifyLinear(token, cfg);
        break;
      case "cicd":
        result = await verifyCicd(token, cfg);
        break;
      case "ai_tooling":
        result = await verifyAiTooling(token, cfg);
        break;
      default:
        result = { ok: false, message: `Unknown connector kind: ${kind}` };
    }
    child.info({ ok: result.ok }, "connector verify end");
    return result;
  } catch (err) {
    child.error({ err }, "connector verify error");
    throw err;
  }
}

export async function runConnector(
  kind: string,
  provider: string,
  token: string,
  config: Record<string, unknown>,
  ctx: ConnectorCtx = {},
): Promise<ConnectorRunResult> {
  const cfg = { ...config, provider };
  const child = logger.child({ requestId: ctx.requestId, op: "runConnector", kind, provider });
  child.info("connector run start");
  try {
    let result: ConnectorRunResult;
    switch (kind) {
      case "github":
        result = await runGithub(token, cfg);
        break;
      case "gitlab":
        result = await runGitlab(token, cfg);
        break;
      case "jira":
        result = await runJira(token, cfg);
        break;
      case "linear":
        result = await runLinear(token);
        break;
      case "cicd":
        result = await runCicd(token, cfg);
        break;
      case "ai_tooling":
        result = await runAiTooling(token, cfg);
        break;
      default:
        throw new Error(`Unknown connector kind: ${kind}`);
    }
    child.info({ recordsCollected: result.recordsCollected }, "connector run end");
    return result;
  } catch (err) {
    child.error({ err }, "connector run error");
    throw err;
  }
}
