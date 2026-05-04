import type { Dimension } from "./rubric";
import { assertSafeUrlResolved } from "./util";
import { logger } from "./logger";
import {
  bucketTimeInStatus,
  classifyIssueType,
  classifyStatus,
  emptyIssueTypeDistribution,
  percentiles,
  readStatusMappingFromConfig,
  type CanonicalIssueType,
  type IssueTypeDistribution,
  type PercentileTriple,
} from "./metrics";

// Aging WIP threshold: any in-progress issue older than this counts as "aging".
// Two weeks matches the typical sprint length so anything spilling past one
// sprint shows up. Aligned across Jira and Linear so dashboards compare apples
// to apples.
const AGING_WIP_THRESHOLD_DAYS = 14;

// ---------------------------------------------------------------------------
// Issue-tracking flow metrics — shared accumulator
// ---------------------------------------------------------------------------
// Computed identically by the Jira and Linear runners so the scoring engine
// sees the same metric shape regardless of provider. Each field can be null
// when the underlying signal isn't measurable (e.g. no sprints configured).

interface IssueFlowMetrics {
  sampleSize: number;
  cycleTimeHoursAvg: number | null;
  leadTimeHoursAvg: number | null;
  cycleTimeHoursPctl: PercentileTriple;
  leadTimeHoursPctl: PercentileTriple;
  flowEfficiencyPct: number | null;
  blockedTimeHoursAvg: number | null;
  throughputPerSprintAvg: number | null;
  sprintCompletionRatePct: number | null;
  sprintsObserved: number;
  currentWip: number;
  // Number of in-progress issues we actually inspected for aging — when
  // smaller than `currentWip` the aging count is a lower bound and the
  // share is computed against `currentWipSampled` (not `currentWip`) so we
  // don't divide a partial numerator by a complete denominator.
  currentWipSampled: number;
  agingWipCount: number;
  agingWipOldestDays: number | null;
  issueTypeDistribution: IssueTypeDistribution;
  backlogSize: number | null;
  // Set to true when backlog or created counts hit the per-call pagination
  // cap; signals to the UI that the figure is a lower bound.
  backlogSizeCapped: boolean;
  backlogGrowthCapped: boolean;
  backlogGrowthPerDay: number | null;
}

/**
 * Project an IssueFlowMetrics block onto the run summary as snake_case keys
 * and emit the matching evidence rows. Used by both Jira and Linear so the
 * shape is identical regardless of provider.
 */
function emitIssueTrackingMetrics(
  m: IssueFlowMetrics,
  providerLabel: string,
  hasSprintCadence: boolean,
  evidence: CollectedEvidence[],
  summary: Record<string, unknown>,
  noSprintCadenceMessage: string,
): void {
  summary.issueTracking = {
    sampleSize: m.sampleSize,
    cycleTimeHoursAvg: m.cycleTimeHoursAvg,
    leadTimeHoursAvg: m.leadTimeHoursAvg,
    cycleTimeHoursPctl: m.cycleTimeHoursPctl,
    leadTimeHoursPctl: m.leadTimeHoursPctl,
    flowEfficiencyPct: m.flowEfficiencyPct,
    blockedTimeHoursAvg: m.blockedTimeHoursAvg,
    throughputPerSprintAvg: m.throughputPerSprintAvg,
    sprintCompletionRatePct: m.sprintCompletionRatePct,
    sprintsObserved: m.sprintsObserved,
    currentWip: m.currentWip,
    currentWipSampled: m.currentWipSampled,
    agingWipCount: m.agingWipCount,
    agingWipOldestDays: m.agingWipOldestDays,
    issueTypeDistribution: m.issueTypeDistribution,
    backlogSize: m.backlogSize,
    backlogSizeCapped: m.backlogSizeCapped,
    backlogGrowthCapped: m.backlogGrowthCapped,
    backlogGrowthPerDay: m.backlogGrowthPerDay,
  };

  // Cycle/lead time percentiles. Stage thresholds match the existing
  // averages-only thresholds used in the source-control runners so the
  // scoring engine doesn't see two competing scales.
  if (m.cycleTimeHoursPctl.p50 !== null) {
    const p50 = m.cycleTimeHoursPctl.p50;
    const p95 = m.cycleTimeHoursPctl.p95 ?? p50;
    evidence.push({
      dimension: "process",
      signalType: p50 <= 72 ? "strength" : "gap",
      stageHint: p50 <= 24 ? 5 : p50 <= 72 ? 4 : p50 <= 240 ? 3 : 2,
      text: `Cycle time (${providerLabel}): p50 ${p50.toFixed(1)}h / p75 ${(m.cycleTimeHoursPctl.p75 ?? 0).toFixed(1)}h / p95 ${p95.toFixed(1)}h (n=${m.sampleSize}, 30d).`,
    });
  }
  if (m.leadTimeHoursPctl.p50 !== null) {
    const p50 = m.leadTimeHoursPctl.p50;
    const p95 = m.leadTimeHoursPctl.p95 ?? p50;
    evidence.push({
      dimension: "process",
      signalType: p50 <= 72 ? "strength" : "gap",
      stageHint: p50 <= 24 ? 5 : p50 <= 72 ? 4 : p50 <= 240 ? 3 : 2,
      text: `Lead time (${providerLabel}): p50 ${p50.toFixed(1)}h / p75 ${(m.leadTimeHoursPctl.p75 ?? 0).toFixed(1)}h / p95 ${p95.toFixed(1)}h (n=${m.sampleSize}, 30d).`,
    });
  }

  // Flow efficiency — active time over (active+blocked+todo). PRD §6.2.
  if (m.flowEfficiencyPct !== null) {
    evidence.push({
      dimension: "process",
      signalType: m.flowEfficiencyPct >= 40 ? "strength" : "gap",
      stageHint:
        m.flowEfficiencyPct >= 60
          ? 5
          : m.flowEfficiencyPct >= 40
            ? 4
            : m.flowEfficiencyPct >= 20
              ? 3
              : 2,
      text: `Flow efficiency (${providerLabel}): ${m.flowEfficiencyPct.toFixed(0)}% of cycle time spent in active work (n=${m.sampleSize}, 30d).`,
    });
  }

  // Blocked time — average per issue.
  if (m.blockedTimeHoursAvg !== null && m.blockedTimeHoursAvg > 0) {
    evidence.push({
      dimension: "process",
      signalType: m.blockedTimeHoursAvg <= 8 ? "strength" : "gap",
      stageHint: m.blockedTimeHoursAvg <= 4 ? 4 : m.blockedTimeHoursAvg <= 24 ? 3 : 2,
      text: `Blocked time (${providerLabel}): avg ${m.blockedTimeHoursAvg.toFixed(1)} hours per resolved issue (30d).`,
    });
  }

  // Throughput — issues per sprint (or per 2-week rolling window).
  if (m.throughputPerSprintAvg !== null) {
    const cadenceLabel = hasSprintCadence ? "per sprint" : "per 2-week window";
    evidence.push({
      dimension: "process",
      signalType: m.throughputPerSprintAvg >= 5 ? "strength" : "gap",
      stageHint:
        m.throughputPerSprintAvg >= 15
          ? 5
          : m.throughputPerSprintAvg >= 5
            ? 4
            : m.throughputPerSprintAvg >= 2
              ? 3
              : 2,
      text: `Throughput (${providerLabel}): avg ${m.throughputPerSprintAvg.toFixed(1)} issues completed ${cadenceLabel} (n=${m.sprintsObserved}).`,
    });
  }

  // Sprint/cycle completion rate — only meaningful when sprints exist.
  if (hasSprintCadence && m.sprintCompletionRatePct !== null) {
    evidence.push({
      dimension: "process",
      signalType: m.sprintCompletionRatePct >= 80 ? "strength" : "gap",
      stageHint:
        m.sprintCompletionRatePct >= 90
          ? 5
          : m.sprintCompletionRatePct >= 80
            ? 4
            : m.sprintCompletionRatePct >= 60
              ? 3
              : 2,
      text: `Sprint completion (${providerLabel}): ${m.sprintCompletionRatePct.toFixed(0)}% of committed issues finished across ${m.sprintsObserved} closed sprints/cycles.`,
    });
  } else if (!hasSprintCadence) {
    evidence.push({
      dimension: "process",
      signalType: "gap",
      stageHint: 1,
      text: noSprintCadenceMessage,
    });
  }

  // Current and aging WIP. Aging share uses the *inspected* sample as the
  // denominator so a partial scan (e.g. capped pagination) doesn't divide
  // a partial numerator by the full queue size and silently understate the
  // share. We surface the inspected-vs-total ratio in the evidence text so
  // assessors know when the figure is a lower bound.
  if (m.currentWip > 0) {
    const aging = m.agingWipCount;
    const oldest = m.agingWipOldestDays;
    const denom = Math.max(1, m.currentWipSampled || m.currentWip);
    const agingShare = aging / denom;
    const sampledNote =
      m.currentWipSampled > 0 && m.currentWipSampled < m.currentWip
        ? ` (sampled ${m.currentWipSampled} of ${m.currentWip})`
        : "";
    evidence.push({
      dimension: "process",
      signalType: agingShare <= 0.2 ? "strength" : "gap",
      stageHint: agingShare <= 0.1 ? 5 : agingShare <= 0.2 ? 4 : agingShare <= 0.4 ? 3 : 2,
      text: `WIP (${providerLabel}): ${m.currentWip} in-progress issues${sampledNote}, ${aging} aging (>${AGING_WIP_THRESHOLD_DAYS}d)${oldest !== null ? `, oldest ${oldest.toFixed(0)}d` : ""}.`,
    });
  } else {
    evidence.push({
      dimension: "process",
      signalType: "quote",
      text: `WIP (${providerLabel}): no in-progress issues currently. Either work is fully shipped or the workflow doesn't use an in-progress state.`,
    });
  }

  // Issue type distribution — bug/feature/tech-debt/chore split.
  const dist = m.issueTypeDistribution;
  const totalTyped = dist.bug + dist.feature + dist.tech_debt + dist.chore + dist.other;
  if (totalTyped > 0) {
    const bugPct = (dist.bug / totalTyped) * 100;
    const techDebtPct = (dist.tech_debt / totalTyped) * 100;
    evidence.push({
      dimension: "process",
      signalType: bugPct <= 30 ? "strength" : "gap",
      stageHint: bugPct <= 15 ? 4 : bugPct <= 30 ? 3 : 2,
      text: `Issue mix (${providerLabel}): ${dist.bug} bugs (${bugPct.toFixed(0)}%), ${dist.feature} features, ${dist.tech_debt} tech-debt (${techDebtPct.toFixed(0)}%), ${dist.chore} chores, ${dist.other} other (n=${totalTyped}, 30d).`,
    });
  }

  // Backlog growth — net inflow per day. When either input was capped at
  // the per-call pagination limit, the growth figure is a lower bound; we
  // append a "≥" hint so the reader interprets it accordingly.
  if (m.backlogGrowthPerDay !== null) {
    const g = m.backlogGrowthPerDay;
    const lowerBound = m.backlogGrowthCapped || m.backlogSizeCapped;
    const sign = g >= 0 ? "+" : "";
    const prefix = lowerBound ? "≥" : "";
    const sizeStr =
      m.backlogSize !== null
        ? ` (current backlog ${m.backlogSizeCapped ? "≥" : ""}${m.backlogSize})`
        : "";
    evidence.push({
      dimension: "measurement",
      signalType: g <= 0 ? "strength" : "gap",
      stageHint: g <= 0 ? 4 : g <= 1 ? 3 : 2,
      text: `Backlog growth (${providerLabel}): net ${prefix}${sign}${g.toFixed(2)} issues/day over the last 30 days${sizeStr}.`,
    });
  }
}

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

  // Deployment frequency (successful workflow runs / day, last 30 days) —
  // proxy for DORA "deployment frequency". Only successful runs count as
  // deployments; failed runs feed change-failure-rate instead so the two
  // metrics stay independent.
  const deploysPerDay = workflowRunsSucceeded / 30;
  summary.workflowRuns30d = workflowRunsTotal;
  summary.workflowRunsSucceeded30d = workflowRunsSucceeded;
  summary.workflowRunsFailed30d = workflowRunsFailed;
  summary.deploysPerDay = Number(deploysPerDay.toFixed(2));
  if (workflowRunsSucceeded > 0) {
    evidence.push({
      dimension: "process",
      signalType: deploysPerDay >= 1 ? "strength" : "gap",
      stageHint: deploysPerDay >= 5 ? 5 : deploysPerDay >= 1 ? 4 : 2,
      text: `Deployment frequency: ~${deploysPerDay.toFixed(2)} successful CI runs/day across sampled repos (30d).`,
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

  // MTTR proxy — incident-labeled issues closed in the last 30 days. We
  // search the org for issues with any of the common incident labels and
  // approximate MTTR as closed_at − created_at. When no such issues exist
  // we surface MTTR as "n/a" rather than fabricate a number.
  let mttrSumMs = 0;
  let mttrCount = 0;
  try {
    // GitHub search treats space-separated `label:` qualifiers as AND. To get
    // "any of these incident labels" we issue one search per label and
    // deduplicate by issue id. This keeps MTTR meaningful when an org tags
    // incidents with only one of the conventional labels.
    const incidentLabels = ["incident", "outage", "p0", "p1"];
    const seen = new Set<number>();
    const incidentItems: Array<{
      id: number;
      created_at: string;
      closed_at: string | null;
    }> = [];
    for (const lbl of incidentLabels) {
      try {
        const q = encodeURIComponent(
          `org:${org} is:issue is:closed closed:>=${since.slice(0, 10)} label:${lbl}`,
        );
        const sr = await ghFetch<{
          items: Array<{ id: number; created_at: string; closed_at: string | null }>;
        }>(token, `https://api.github.com/search/issues?q=${q}&per_page=50`);
        for (const it of sr.items) {
          if (seen.has(it.id)) continue;
          seen.add(it.id);
          incidentItems.push(it);
        }
      } catch {
        // skip a single label if its search fails (rate-limit etc.); other
        // labels still contribute to MTTR.
      }
    }
    for (const i of incidentItems) {
      if (!i.closed_at) continue;
      const dur = new Date(i.closed_at).getTime() - new Date(i.created_at).getTime();
      if (dur > 0) {
        mttrSumMs += dur;
        mttrCount += 1;
      }
    }
    recordsCollected += incidentItems.length;
  } catch {
    // search may fail on tokens without read:org or due to rate limiting;
    // we degrade gracefully to "n/a" below.
  }
  if (mttrCount > 0) {
    const mttrHours = mttrSumMs / mttrCount / 3_600_000;
    summary.mttrHoursAvg = Number(mttrHours.toFixed(1));
    summary.incidentIssues30d = mttrCount;
    evidence.push({
      dimension: "measurement",
      signalType: mttrHours <= 24 ? "strength" : "gap",
      stageHint: mttrHours <= 4 ? 5 : mttrHours <= 24 ? 4 : mttrHours <= 72 ? 3 : 2,
      text: `MTTR proxy: avg ${mttrHours.toFixed(1)} hours to close incident-labeled issues (n=${mttrCount}, 30d).`,
    });
  } else {
    summary.mttrHoursAvg = null;
    summary.incidentIssues30d = 0;
    evidence.push({
      dimension: "measurement",
      signalType: "gap",
      stageHint: 1,
      text: "MTTR n/a — no incident-labeled issues found in the last 30 days. Tag incidents with 'incident', 'outage', 'p0', or 'p1' to enable MTTR measurement.",
    });
  }

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
  let pipelinesSucceeded = 0;
  let mrsMerged = 0;
  let mrLeadSumMs = 0;
  let mrLeadCount = 0;
  let mttrSumMs = 0;
  let mttrCount = 0;
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
        pipelinesSucceeded += rows.filter((x) => x.status === "success").length;
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
    // MTTR proxy — incident-labeled issues closed in the last 30 days for
    // this project. Approximated as closed_at − created_at; if no incident
    // issues exist across the sample we surface MTTR as "n/a" below. The
    // GitLab issues API uses comma-separated `labels` to mean OR, so we
    // pass the same incident label set as the GitHub runner. We also
    // post-filter on closed_at to match the strict 30-day window
    // (updated_after can include issues touched but not closed within it).
    const sinceMs = Date.parse(since);
    try {
      const ir = await fetch(
        `${baseUrl}/api/v4/projects/${p.id}/issues?state=closed&labels=${encodeURIComponent("incident,outage,p0,p1")}&updated_after=${since}&per_page=50`,
        { headers },
      );
      if (ir.ok) {
        const rows = (await ir.json()) as Array<{
          created_at: string;
          closed_at: string | null;
        }>;
        for (const i of rows) {
          if (!i.closed_at) continue;
          const closedMs = new Date(i.closed_at).getTime();
          if (closedMs < sinceMs) continue;
          const dur = closedMs - new Date(i.created_at).getTime();
          if (dur > 0) {
            mttrSumMs += dur;
            mttrCount += 1;
          }
        }
        recordsCollected += rows.length;
      }
    } catch {
      // ignore — incident label may not exist; MTTR will be n/a.
    }
  }

  const summary: Record<string, unknown> = {
    projectCount: projects.length,
    pipelines30d: pipelinesTotal,
    pipelinesSucceeded30d: pipelinesSucceeded,
    pipelinesFailed30d: pipelinesFailed,
    mrsMerged30d: mrsMerged,
  };

  if (pipelinesSucceeded > 0) {
    // Deployment frequency uses successful pipelines only — failed pipelines
    // are not deployments and are accounted for in change-failure-rate.
    const deploysPerDay = pipelinesSucceeded / 30;
    summary.deploysPerDay = Number(deploysPerDay.toFixed(2));
    evidence.push({
      dimension: "process",
      signalType: deploysPerDay >= 1 ? "strength" : "gap",
      stageHint: deploysPerDay >= 5 ? 5 : deploysPerDay >= 1 ? 4 : 2,
      text: `Deployment frequency: ~${deploysPerDay.toFixed(2)} successful pipelines/day across sampled GitLab projects (30d).`,
    });
  }
  if (pipelinesTotal > 0) {
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
  if (mttrCount > 0) {
    const mttrHours = mttrSumMs / mttrCount / 3_600_000;
    summary.mttrHoursAvg = Number(mttrHours.toFixed(1));
    summary.incidentIssues30d = mttrCount;
    evidence.push({
      dimension: "measurement",
      signalType: mttrHours <= 24 ? "strength" : "gap",
      stageHint: mttrHours <= 4 ? 5 : mttrHours <= 24 ? 4 : mttrHours <= 72 ? 3 : 2,
      text: `MTTR proxy: avg ${mttrHours.toFixed(1)} hours to close incident-labeled GitLab issues (n=${mttrCount}, 30d).`,
    });
  } else {
    summary.mttrHoursAvg = null;
    summary.incidentIssues30d = 0;
    evidence.push({
      dimension: "measurement",
      signalType: "gap",
      stageHint: 1,
      text: "MTTR n/a — no GitLab issues with the 'incident' label closed in the last 30 days.",
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

// ---- Jira issue shape -----------------------------------------------------
// Sprint custom field is the standard Jira Cloud default (`customfield_10020`).
// Teams that use a different sprint custom field can override it via
// `config.sprintField`. The field's value can be a list of objects (modern)
// or a list of opaque strings (legacy GreenHopper-era format) — we handle both.

interface JiraStatusChange {
  field: string;
  fromString: string | null;
  toString: string | null;
}
interface JiraHistory {
  created: string;
  items: JiraStatusChange[];
}
interface JiraSprintObject {
  id: number;
  name: string;
  state: string;
  startDate?: string | null;
  endDate?: string | null;
  completeDate?: string | null;
}
interface JiraIssue {
  id: string;
  key?: string;
  fields: {
    created: string;
    resolutiondate: string | null;
    labels?: string[];
    issuetype?: { name: string };
    status?: { name: string };
    [k: string]: unknown;
  };
  changelog?: { histories: JiraHistory[] };
}

interface JiraSearchResponse {
  total: number;
  issues: JiraIssue[];
}

/**
 * Build an ordered status timeline for a Jira issue from its expanded
 * changelog. Returns segments of the form `{ status, at }` where the issue
 * is assumed to remain in `status` until the next segment's `at` (or the
 * issue's resolution timestamp / now for the final segment).
 *
 * The first segment uses the `fromString` of the earliest status transition
 * (i.e. the status the issue was created in). When an issue has no status
 * transitions we fall back to the current status against the createdAt
 * timestamp so blocked-time accounting still has a measurable span.
 */
function buildJiraStatusTimeline(
  issue: JiraIssue,
): Array<{ status: string; at: number }> {
  const createdAt = Date.parse(issue.fields.created);
  const histories = (issue.changelog?.histories ?? [])
    .map((h) => ({
      created: h.created,
      item: h.items.find((i) => i.field === "status"),
    }))
    .filter((h): h is { created: string; item: JiraStatusChange } => Boolean(h.item))
    .sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
  if (histories.length === 0) {
    const cur = issue.fields.status?.name ?? "Unknown";
    return [{ status: cur, at: createdAt }];
  }
  const initial = histories[0]!.item.fromString ?? "To Do";
  const segs: Array<{ status: string; at: number }> = [
    { status: initial, at: createdAt },
  ];
  for (const h of histories) {
    if (!h.item.toString) continue;
    segs.push({ status: h.item.toString, at: Date.parse(h.created) });
  }
  return segs;
}

/**
 * Pull sprint metadata out of a Jira issue's custom field. Returns an empty
 * array when the field is missing or unrecognised so callers can still emit
 * the per-issue metrics without sprint cadence.
 */
function readJiraSprints(issue: JiraIssue, sprintField: string): JiraSprintObject[] {
  const raw = issue.fields[sprintField];
  if (!Array.isArray(raw)) return [];
  const out: JiraSprintObject[] = [];
  for (const v of raw) {
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const id = typeof o.id === "number" ? o.id : Number(o.id);
      if (!Number.isFinite(id)) continue;
      out.push({
        id,
        name: String(o.name ?? `Sprint ${id}`),
        state: String(o.state ?? "active").toLowerCase(),
        startDate: typeof o.startDate === "string" ? o.startDate : null,
        endDate: typeof o.endDate === "string" ? o.endDate : null,
        completeDate: typeof o.completeDate === "string" ? o.completeDate : null,
      });
    } else if (typeof v === "string") {
      // Legacy "com.atlassian.greenhopper.service.sprint.Sprint@...[id=12,...]" string.
      const idMatch = /id=(\d+)/.exec(v);
      const stateMatch = /state=([A-Z]+)/.exec(v);
      const nameMatch = /name=([^,\]]+)/.exec(v);
      if (!idMatch) continue;
      out.push({
        id: Number(idMatch[1]),
        name: nameMatch?.[1] ?? `Sprint ${idMatch[1]}`,
        state: (stateMatch?.[1] ?? "ACTIVE").toLowerCase(),
      });
    }
  }
  return out;
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
  const statusMapping = readStatusMappingFromConfig(config);
  const sprintField = String(config.sprintField ?? "customfield_10020");
  const evidence: CollectedEvidence[] = [];
  const summary: Record<string, unknown> = {};

  // ---- 1. Resolved issues with changelog + sprint info (last 30d) --------
  // expand=changelog returns the full status transition history per issue,
  // which we need for flow-efficiency / blocked-time accounting.
  const resolvedJql = `${projClause}resolved >= -30d ORDER BY resolved DESC`;
  const fields = `created,resolutiondate,labels,issuetype,status,${sprintField}`;
  const r = await fetch(
    `${baseUrl}/rest/api/3/search?jql=${encodeURIComponent(resolvedJql)}&fields=${encodeURIComponent(fields)}&expand=changelog&maxResults=100`,
    { headers },
  );
  if (!r.ok) throw new Error(`Jira ${r.status}`);
  const data = (await r.json()) as JiraSearchResponse;
  let recordsCollected = data.issues.length;

  evidence.push({
    dimension: "process",
    signalType: "strength",
    stageHint: 2,
    text: `Jira project has ${data.total} resolved issues in the last 30 days — active planning process.`,
  });

  // ---- 2. Per-issue cycle/lead time + flow buckets + MTTR ----------------
  const cycleHours: number[] = [];
  const leadHours: number[] = [];
  let activeMsTotal = 0;
  let blockedMsTotal = 0;
  let todoMsTotal = 0;
  const blockedHoursPerIssue: number[] = [];
  let mttrSumMs = 0;
  let mttrCount = 0;
  // Sprint accumulators: throughput is "issues completed in a sprint", and
  // sprint completion rate is computed from issues that observably belonged
  // to a closed sprint at any point in their resolution history.
  const sprintCompletedById = new Map<number, { name: string; completed: number }>();
  // Issue-type distribution
  const issueTypeDistribution = emptyIssueTypeDistribution();

  const isIncident = (i: JiraIssue) => {
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
    const created = Date.parse(issue.fields.created);
    const resolved = Date.parse(issue.fields.resolutiondate);
    const leadMs = resolved - created;
    if (leadMs <= 0) continue;
    leadHours.push(leadMs / 3_600_000);

    // Status timeline → bucketed time-in-status. Cycle time = first-time-in-
    // progress → resolved. When no in_progress segment exists (issue was
    // resolved without ever moving to active), cycle time falls back to lead
    // time so the percentile is still meaningful.
    const segs = buildJiraStatusTimeline(issue);
    const buckets = bucketTimeInStatus(segs, resolved, statusMapping);
    activeMsTotal += buckets.active;
    blockedMsTotal += buckets.blocked;
    todoMsTotal += buckets.todo;
    blockedHoursPerIssue.push(buckets.blocked / 3_600_000);
    const firstActive = segs.find(
      (s) => classifyStatus(s.status, statusMapping) === "in_progress",
    );
    const cycleStart = firstActive?.at ?? created;
    const cycleMs = Math.max(0, resolved - cycleStart);
    if (cycleMs > 0) cycleHours.push(cycleMs / 3_600_000);
    else cycleHours.push(leadMs / 3_600_000);

    // Issue-type distribution
    const t = classifyIssueType(issue.fields.issuetype?.name);
    issueTypeDistribution[t] += 1;

    // Sprint membership — count this resolved issue against every closed
    // sprint it ever belonged to. (Issues moved between sprints contribute
    // to each sprint's completion bucket; this is the same convention Jira
    // uses internally for "completed issues" in a sprint report.)
    const sprints = readJiraSprints(issue, sprintField);
    for (const sp of sprints) {
      if (sp.state !== "closed") continue;
      const acc = sprintCompletedById.get(sp.id) ?? { name: sp.name, completed: 0 };
      acc.completed += 1;
      sprintCompletedById.set(sp.id, acc);
    }

    // MTTR proxy (incident-tagged issues)
    if (isIncident(issue)) {
      mttrSumMs += leadMs;
      mttrCount += 1;
    }
  }

  const sample = data.issues.length;
  // Volume-weighted flow efficiency: sum(active) / sum(active+blocked+todo).
  // Mean-of-ratios is more sensitive to short-lived issues; the volume-
  // weighted form better reflects how the team actually spent its time.
  const flowDenom = activeMsTotal + blockedMsTotal + todoMsTotal;
  const flowEffPct = flowDenom > 0 ? (activeMsTotal / flowDenom) * 100 : null;
  const blockedAvg =
    blockedHoursPerIssue.length > 0
      ? blockedHoursPerIssue.reduce((a, b) => a + b, 0) / blockedHoursPerIssue.length
      : null;
  const cycleAvg =
    cycleHours.length > 0
      ? cycleHours.reduce((a, b) => a + b, 0) / cycleHours.length
      : null;
  const leadAvg =
    leadHours.length > 0
      ? leadHours.reduce((a, b) => a + b, 0) / leadHours.length
      : null;

  // ---- 3. Sprint completion rate -----------------------------------------
  // We need the *committed* count per closed sprint, not just the completed
  // count. The Agile API exposes that via /sprint/{id} for each closed
  // sprint we observed. We query the few sprints we found rather than every
  // sprint on every board to keep the call budget bounded.
  let sprintCommittedTotal = 0;
  let sprintCompletedTotal = 0;
  let sprintsObserved = 0;
  for (const [sprintId, acc] of sprintCompletedById) {
    try {
      // Fetch sprint metadata first so we can use the sprint's completion
      // (or end) date as the cutoff for "completed in sprint" — without it
      // we'd inflate the completion rate by counting issues resolved long
      // after the sprint closed (carry-over to a later cadence).
      const metaReq = fetch(
        `${baseUrl}/rest/agile/1.0/sprint/${sprintId}`,
        { headers },
      );
      const issuesReq = fetch(
        `${baseUrl}/rest/agile/1.0/sprint/${sprintId}/issue?fields=resolutiondate&maxResults=200`,
        { headers },
      );
      const [metaRes, sr] = await Promise.all([metaReq, issuesReq]);
      if (!sr.ok) continue;
      let cutoffMs: number | null = null;
      if (metaRes.ok) {
        const md = (await metaRes.json()) as {
          completeDate?: string | null;
          endDate?: string | null;
        };
        const c = md.completeDate ?? md.endDate ?? null;
        if (c) cutoffMs = Date.parse(c);
      }
      const sd = (await sr.json()) as {
        issues: Array<{ fields: { resolutiondate: string | null } }>;
      };
      const committed = sd.issues.length;
      const resolvedInSprint = sd.issues.filter((i) => {
        const rd = i.fields.resolutiondate;
        if (!rd) return false;
        if (cutoffMs === null) return true;
        return Date.parse(rd) <= cutoffMs;
      }).length;
      sprintCommittedTotal += committed;
      sprintCompletedTotal += resolvedInSprint;
      sprintsObserved += 1;
      recordsCollected += committed;
      // Use the cutoff-aware count instead of our pre-computed one when
      // available — Agile counts subtasks consistently and we want the
      // strict "completed by sprint end" semantics here.
      acc.completed = resolvedInSprint;
    } catch {
      // ignore individual sprint failures; remaining sprints still contribute.
    }
  }
  const hasSprintCadence = sprintsObserved > 0;
  const sprintCompletionRatePct =
    hasSprintCadence && sprintCommittedTotal > 0
      ? (sprintCompletedTotal / sprintCommittedTotal) * 100
      : null;
  const throughputPerSprintAvg = hasSprintCadence
    ? sprintCompletedTotal / sprintsObserved
    : leadHours.length > 0
      ? leadHours.length / Math.max(1, 30 / 14)
      : null;

  // ---- 4. Currently in-progress (aging WIP) -------------------------------
  // Paginate up to 5 pages of 100 (= 500 issues) sorted by `updated ASC` so
  // the *oldest-stale* items come first. Any aging issues are concentrated
  // in early pages (aging means "not updated in 14+ days" → older `updated`
  // timestamp), so we short-circuit when a page yields zero new aging items.
  // The aging-share denominator in `emitIssueTrackingMetrics` uses the
  // `currentWipSampled` field instead of `currentWip` (= total) so we never
  // divide a partial numerator by a complete denominator.
  let currentWip = 0;
  let currentWipSampled = 0;
  let agingWipCount = 0;
  let agingWipOldestDays: number | null = null;
  try {
    const wipJql = `${projClause}statusCategory = "In Progress" ORDER BY updated ASC`;
    const PAGE = 100;
    const MAX_PAGES = 5;
    const now = Date.now();
    for (let page = 0; page < MAX_PAGES; page++) {
      const wipRes = await fetch(
        `${baseUrl}/rest/api/3/search?jql=${encodeURIComponent(wipJql)}&fields=updated,created,status&maxResults=${PAGE}&startAt=${page * PAGE}`,
        { headers },
      );
      if (!wipRes.ok) break;
      const wipData = (await wipRes.json()) as {
        total: number;
        issues: Array<{ fields: { created: string; updated: string } }>;
      };
      if (page === 0) currentWip = wipData.total;
      let agingThisPage = 0;
      for (const i of wipData.issues) {
        const ageDays = (now - Date.parse(i.fields.updated)) / 86_400_000;
        if (ageDays > AGING_WIP_THRESHOLD_DAYS) {
          agingWipCount += 1;
          agingThisPage += 1;
        }
        if (agingWipOldestDays === null || ageDays > agingWipOldestDays) {
          agingWipOldestDays = ageDays;
        }
      }
      currentWipSampled += wipData.issues.length;
      recordsCollected += wipData.issues.length;
      if (wipData.issues.length < PAGE) break;
      if (agingThisPage === 0) break;
    }
  } catch {
    // WIP is best-effort; degrade silently and surface 0/null.
  }

  // ---- 5. Backlog growth: created vs resolved in the last 30 days --------
  let createdLast30d: number | null = null;
  let resolvedLast30d: number | null = null;
  let backlogSize: number | null = null;
  try {
    const cReq = fetch(
      `${baseUrl}/rest/api/3/search?jql=${encodeURIComponent(
        `${projClause}created >= -30d`,
      )}&fields=created&maxResults=0`,
      { headers },
    );
    const rReq = fetch(
      `${baseUrl}/rest/api/3/search?jql=${encodeURIComponent(
        `${projClause}resolved >= -30d`,
      )}&fields=resolutiondate&maxResults=0`,
      { headers },
    );
    const bReq = fetch(
      `${baseUrl}/rest/api/3/search?jql=${encodeURIComponent(
        `${projClause}statusCategory = "To Do"`,
      )}&fields=created&maxResults=0`,
      { headers },
    );
    const [cR, rR, bR] = await Promise.all([cReq, rReq, bReq]);
    if (cR.ok) {
      createdLast30d = ((await cR.json()) as { total: number }).total;
    }
    if (rR.ok) {
      resolvedLast30d = ((await rR.json()) as { total: number }).total;
    }
    if (bR.ok) {
      backlogSize = ((await bR.json()) as { total: number }).total;
    }
  } catch {
    // ignore; growth surfaces as null.
  }
  const backlogGrowthPerDay =
    createdLast30d !== null && resolvedLast30d !== null
      ? (createdLast30d - resolvedLast30d) / 30
      : null;

  // ---- Assemble + emit ----------------------------------------------------
  const metrics: IssueFlowMetrics = {
    sampleSize: sample,
    cycleTimeHoursAvg: cycleAvg,
    leadTimeHoursAvg: leadAvg,
    cycleTimeHoursPctl: percentiles(cycleHours),
    leadTimeHoursPctl: percentiles(leadHours),
    flowEfficiencyPct: flowEffPct,
    blockedTimeHoursAvg: blockedAvg,
    throughputPerSprintAvg,
    sprintCompletionRatePct,
    sprintsObserved,
    currentWip,
    currentWipSampled,
    agingWipCount,
    agingWipOldestDays,
    issueTypeDistribution,
    backlogSize,
    // Jira's `total` field is authoritative regardless of `maxResults`, so
    // these counters are never silently capped.
    backlogSizeCapped: false,
    backlogGrowthCapped: false,
    backlogGrowthPerDay,
  };

  // Preserve back-compat keys used by the existing scoring/UI paths so the
  // upgrade doesn't break dashboards looking for the old summary shape.
  summary.totalIssues = data.total;
  summary.sampleSize = sample;
  summary.resolved30d = leadHours.length;
  if (cycleAvg !== null) summary.cycleTimeHoursAvg = Number(cycleAvg.toFixed(1));

  emitIssueTrackingMetrics(
    metrics,
    "Jira",
    hasSprintCadence,
    evidence,
    summary,
    "No Jira sprint cadence detected — set up a Scrum board with active sprints to enable sprint completion + throughput metrics.",
  );

  // ---- MTTR proxy (kept under the existing `measurement` dimension) ------
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
    recordsCollected,
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

// ---- Linear shapes -------------------------------------------------------
// Linear's GraphQL `IssueHistory` only includes nodes where the relevant
// field actually changed, so for state transitions `fromState`/`toState` are
// the authoritative source. `state.type` is one of `backlog`, `unstarted`,
// `started`, `completed`, `canceled` — we map those onto our canonical
// buckets ourselves rather than trusting the `name` field, which teams
// frequently rename.

interface LinearStateRef {
  name: string;
  type: string;
}
interface LinearIssueNode {
  id: string;
  identifier?: string;
  createdAt: string;
  completedAt: string | null;
  labels: { nodes: Array<{ name: string }> };
  state?: LinearStateRef | null;
  cycle?: { id: string; name?: string | null; endsAt?: string | null } | null;
  history?: {
    nodes: Array<{
      createdAt: string;
      fromState?: LinearStateRef | null;
      toState?: LinearStateRef | null;
    }>;
  };
}

interface LinearCycleNode {
  id: string;
  name?: string | null;
  startsAt: string | null;
  endsAt: string | null;
  completedAt: string | null;
  issueCount?: number | null;
  completedIssueCount?: number | null;
}

/**
 * Map Linear's `state.type` enum onto our canonical status buckets. We
 * accept the explicit type so the user-facing state name (which can be
 * anything) doesn't matter.
 */
function linearStateTypeToCanonical(type: string): string {
  switch (type.toLowerCase()) {
    case "backlog":
    case "unstarted":
    case "triage":
      return "To Do";
    case "started":
      return "In Progress";
    case "completed":
      return "Done";
    case "canceled":
      return "Done";
    default:
      return type;
  }
}

/**
 * Build a status timeline from Linear's history nodes. Linear emits one
 * history entry per state change, with `fromState` on the earliest entry
 * giving the issue's initial state. When history is empty we fall back to
 * the current state against the createdAt.
 */
function buildLinearStatusTimeline(
  issue: LinearIssueNode,
): Array<{ status: string; at: number }> {
  const createdAt = Date.parse(issue.createdAt);
  const histories = (issue.history?.nodes ?? [])
    .filter((h) => h.toState || h.fromState)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (histories.length === 0) {
    const cur = issue.state
      ? linearStateTypeToCanonical(issue.state.type)
      : "Unknown";
    return [{ status: cur, at: createdAt }];
  }
  const initial = histories[0]!.fromState
    ? linearStateTypeToCanonical(histories[0]!.fromState!.type)
    : "To Do";
  const segs: Array<{ status: string; at: number }> = [
    { status: initial, at: createdAt },
  ];
  for (const h of histories) {
    if (!h.toState) continue;
    segs.push({
      status: linearStateTypeToCanonical(h.toState.type),
      at: Date.parse(h.createdAt),
    });
  }
  return segs;
}

/**
 * Paginated counter for Linear issue queries — used for backlog and recent
 * inflow counts where Linear's connection types don't expose a `totalCount`
 * field. Walks `pageInfo.endCursor` until exhausted or `MAX_PAGES`. Returns
 * `{count, capped}` so callers can flag the figure as a lower bound when we
 * stop early.
 *
 * The filter is passed as a typed GraphQL variable (`$filter: IssueFilter!`)
 * rather than interpolated into the query string so callers can safely pass
 * arbitrary filter objects without hand-escaping.
 */
async function countLinearIssues(
  token: string,
  filter: Record<string, unknown>,
): Promise<{ count: number; capped: boolean }> {
  const PAGE = 250;
  const MAX_PAGES = 4; // 1000 issues max per counter — bounded API budget.
  let count = 0;
  let cursor: string | null = null;
  let capped = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({
        query: `query($filter: IssueFilter!, $cursor: String) {
          issues(first: ${PAGE}, filter: $filter, after: $cursor) {
            nodes { id }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        variables: { filter, cursor },
      }),
    });
    if (!r.ok) break;
    const data = (await r.json()) as {
      data?: {
        issues: {
          nodes: Array<{ id: string }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
      errors?: Array<{ message: string }>;
    };
    if (!data.data || data.errors?.length) break;
    count += data.data.issues.nodes.length;
    if (!data.data.issues.pageInfo.hasNextPage) {
      return { count, capped: false };
    }
    cursor = data.data.issues.pageInfo.endCursor;
    if (page === MAX_PAGES - 1) capped = true;
  }
  return { count, capped };
}

async function runLinear(
  token: string,
  config: Record<string, unknown>,
): Promise<ConnectorRunResult> {
  // Batched GraphQL query for the metrics that benefit from co-location
  // (completed issues, in-progress, cycles). Backlog and recent-created
  // counters are fetched separately via `countLinearIssues` so they can
  // paginate up to 1000 items each instead of being silently capped at the
  // first 250 the inline query would have returned.
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const cycleSince = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const statusMapping = readStatusMappingFromConfig(config);
  const r = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({
      query: `query($since: DateTimeOrDuration!, $cycleSince: DateTimeOrDuration!) {
        teams { nodes { id name } }
        completed: issues(first: 100, filter: { completedAt: { gte: $since } }) {
          nodes {
            id
            identifier
            createdAt
            completedAt
            labels { nodes { name } }
            state { name type }
            cycle { id name endsAt }
            history(first: 50) {
              nodes {
                createdAt
                fromState { name type }
                toState { name type }
              }
            }
          }
        }
        inProgress: issues(first: 100, filter: { state: { type: { eq: "started" } } }) {
          nodes {
            id
            createdAt
            updatedAt
            state { name type }
          }
        }
        cycles(first: 25, filter: { endsAt: { gte: $cycleSince } }) {
          nodes {
            id
            name
            startsAt
            endsAt
            completedAt
            issueCount
            completedIssueCount
          }
        }
      }`,
      variables: { since, cycleSince },
    }),
  });
  if (!r.ok) throw new Error(`Linear ${r.status}`);
  const data = (await r.json()) as {
    data?: {
      teams: { nodes: Array<{ id: string; name: string }> };
      completed: { nodes: LinearIssueNode[] };
      inProgress: {
        nodes: Array<{
          id: string;
          createdAt: string;
          updatedAt: string;
          state?: LinearStateRef | null;
        }>;
      };
      cycles: { nodes: LinearCycleNode[] };
    };
    errors?: Array<{ message: string }>;
  };
  if (data.errors?.length) throw new Error(data.errors[0]!.message);
  if (!data.data) throw new Error("Linear: empty response");

  const teams = data.data.teams.nodes.length;
  const issues = data.data.completed.nodes;
  const wipNodes = data.data.inProgress.nodes;
  const cycleNodes = data.data.cycles.nodes;

  // Run the two paginated counters in parallel so we don't add a serial
  // round-trip to the user-facing latency budget.
  const [backlogResult, createdRecentResult] = await Promise.all([
    countLinearIssues(token, { state: { type: { eq: "backlog" } } }).catch(
      () => ({ count: 0, capped: false }),
    ),
    countLinearIssues(token, { createdAt: { gte: since } }).catch(() => ({
      count: 0,
      capped: false,
    })),
  ]);

  // ---- Per-issue cycle/lead/flow accounting ------------------------------
  const cycleHours: number[] = [];
  const leadHours: number[] = [];
  let activeMsTotal = 0;
  let blockedMsTotal = 0;
  let todoMsTotal = 0;
  const blockedHoursPerIssue: number[] = [];
  let mttrSumMs = 0;
  let mttrCount = 0;
  const issueTypeDistribution = emptyIssueTypeDistribution();

  for (const i of issues) {
    if (!i.completedAt) continue;
    const created = Date.parse(i.createdAt);
    const completed = Date.parse(i.completedAt);
    const leadMs = completed - created;
    if (leadMs <= 0) continue;
    leadHours.push(leadMs / 3_600_000);

    const segs = buildLinearStatusTimeline(i);
    const buckets = bucketTimeInStatus(segs, completed, statusMapping);
    activeMsTotal += buckets.active;
    blockedMsTotal += buckets.blocked;
    todoMsTotal += buckets.todo;
    blockedHoursPerIssue.push(buckets.blocked / 3_600_000);
    const firstActive = segs.find(
      (s) => classifyStatus(s.status, statusMapping) === "in_progress",
    );
    const cycleStart = firstActive?.at ?? created;
    const cycleMs = Math.max(0, completed - cycleStart);
    cycleHours.push(cycleMs > 0 ? cycleMs / 3_600_000 : leadMs / 3_600_000);

    // Issue type — Linear doesn't have a first-class "type" field, so we
    // infer from labels. Common conventions: "bug", "feature", "tech debt",
    // "chore". We pick the *first* matching label so a "bug" labelled issue
    // can't double-count as both bug and tech-debt.
    const labelNames = i.labels.nodes.map((l) => l.name);
    let typed: CanonicalIssueType = "other";
    for (const ln of labelNames) {
      const t = classifyIssueType(ln);
      if (t !== "other") {
        typed = t;
        break;
      }
    }
    issueTypeDistribution[typed] += 1;

    const labelsLower = labelNames.map((l) => l.toLowerCase());
    if (
      labelsLower.includes("incident") ||
      labelsLower.includes("outage") ||
      labelsLower.includes("p0") ||
      labelsLower.includes("p1")
    ) {
      mttrSumMs += leadMs;
      mttrCount += 1;
    }
  }

  const flowDenom = activeMsTotal + blockedMsTotal + todoMsTotal;
  const flowEffPct = flowDenom > 0 ? (activeMsTotal / flowDenom) * 100 : null;
  const blockedAvg =
    blockedHoursPerIssue.length > 0
      ? blockedHoursPerIssue.reduce((a, b) => a + b, 0) / blockedHoursPerIssue.length
      : null;
  const cycleAvg =
    cycleHours.length > 0
      ? cycleHours.reduce((a, b) => a + b, 0) / cycleHours.length
      : null;
  const leadAvg =
    leadHours.length > 0
      ? leadHours.reduce((a, b) => a + b, 0) / leadHours.length
      : null;

  // ---- Cycle (sprint analogue) completion + throughput ------------------
  // Only consider cycles that actually ended (completedAt or endsAt in the
  // past) so an in-flight cycle doesn't drag completion rate down.
  const now = Date.now();
  const closedCycles = cycleNodes.filter(
    (c) =>
      (c.completedAt && Date.parse(c.completedAt) <= now) ||
      (c.endsAt && Date.parse(c.endsAt) <= now),
  );
  const sprintsObserved = closedCycles.length;
  const hasSprintCadence = sprintsObserved > 0;
  let sprintCompletionRatePct: number | null = null;
  let throughputPerSprintAvg: number | null = null;
  if (hasSprintCadence) {
    const totalCommitted = closedCycles.reduce(
      (a, c) => a + (c.issueCount ?? 0),
      0,
    );
    const totalCompleted = closedCycles.reduce(
      (a, c) => a + (c.completedIssueCount ?? 0),
      0,
    );
    if (totalCommitted > 0) {
      sprintCompletionRatePct = (totalCompleted / totalCommitted) * 100;
    }
    throughputPerSprintAvg = totalCompleted / sprintsObserved;
  } else if (leadHours.length > 0) {
    // No cycles configured — fall back to a 2-week rolling-window throughput
    // so the metric is still meaningful for kanban-style teams.
    throughputPerSprintAvg = leadHours.length / Math.max(1, 30 / 14);
  }

  // ---- Aging WIP ---------------------------------------------------------
  let agingWipCount = 0;
  let agingWipOldestDays: number | null = null;
  for (const w of wipNodes) {
    const age = (now - Date.parse(w.updatedAt)) / 86_400_000;
    if (age > AGING_WIP_THRESHOLD_DAYS) agingWipCount += 1;
    if (agingWipOldestDays === null || age > agingWipOldestDays) {
      agingWipOldestDays = age;
    }
  }

  // ---- Backlog growth ---------------------------------------------------
  // Linear's connection types don't expose totalCount; we paginate via
  // `countLinearIssues` (cursor walk, MAX_PAGES=4 → up to 1000). When either
  // side hits the cap the metrics block carries a `*Capped` flag so the UI
  // can render the figure as a lower bound.
  const backlogSize = backlogResult.count;
  const createdLast30d = createdRecentResult.count;
  const resolvedLast30d = leadHours.length;
  const backlogGrowthPerDay = (createdLast30d - resolvedLast30d) / 30;

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
  if (cycleAvg !== null) summary.cycleTimeHoursAvg = Number(cycleAvg.toFixed(1));

  const metrics: IssueFlowMetrics = {
    sampleSize: leadHours.length,
    cycleTimeHoursAvg: cycleAvg,
    leadTimeHoursAvg: leadAvg,
    cycleTimeHoursPctl: percentiles(cycleHours),
    leadTimeHoursPctl: percentiles(leadHours),
    flowEfficiencyPct: flowEffPct,
    blockedTimeHoursAvg: blockedAvg,
    throughputPerSprintAvg,
    sprintCompletionRatePct,
    sprintsObserved,
    currentWip: wipNodes.length,
    // Linear's in-progress query is capped at 100 nodes; for parity with
    // Jira (which paginates) we treat the inline batch as the inspected
    // sample. When teams run hotter than 100 in-progress this is a soft
    // ceiling, but the share calc in `emitIssueTrackingMetrics` divides
    // aging by the sampled size (not the total) so the reported share
    // stays accurate against what we actually inspected.
    currentWipSampled: wipNodes.length,
    agingWipCount,
    agingWipOldestDays,
    issueTypeDistribution,
    backlogSize,
    backlogSizeCapped: backlogResult.capped,
    backlogGrowthCapped: createdRecentResult.capped,
    backlogGrowthPerDay,
  };

  emitIssueTrackingMetrics(
    metrics,
    "Linear",
    hasSprintCadence,
    evidence,
    summary,
    "No Linear cycles detected in the last 60 days — enable cycles on a team to measure cycle completion + throughput.",
  );

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
    recordsCollected:
      teams + issues.length + wipNodes.length + backlogResult.count,
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
  if (provider === "gitlab_ci") {
    // gitlab_ci CI/CD connectors share semantics with the GitLab connector
    // (token + baseUrl + group). Reuse verifyGitlab so verify and run stay
    // consistent — without this delegation a connector configured for
    // gitlab_ci would Run successfully but Verify would always fail.
    return verifyGitlab(token, config);
  }
  if (provider === "jenkins") {
    return verifyJenkins(token, config);
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
  if (provider === "circleci") {
    return runCircleCi(token, config);
  }
  if (provider === "gitlab_ci") {
    // GitLab CI shares the same backend as the GitLab connector; reuse the
    // pipeline metrics path so deploy/change-fail come out normalized.
    return runGitlab(token, config);
  }
  if (provider === "jenkins") {
    const out = await runJenkins(token, config);
    out.evidence.push({
      dimension: "process",
      signalType: "strength",
      stageHint: 3,
      text: "CI/CD pipeline (Jenkins) actively in use.",
    });
    return out;
  }
  // Unknown providers get an explicit "no collector available" gap so the
  // dimension is visibly uncovered.
  return {
    recordsCollected: 0,
    summary: { provider, deploysPerDay: null, changeFailureRate: null },
    evidence: [
      {
        dimension: "process",
        signalType: "gap",
        stageHint: 1,
        text: `CI/CD connector configured for ${provider}, but no automated collector exists for this provider yet. Add a GitHub Actions, GitLab CI, CircleCI, or Jenkins connector for DORA coverage.`,
      },
    ],
  };
}

// Pulls the most recent workflows/pipelines from a CircleCI project to
// compute the same DORA-style proxies as GitHub/GitLab. Config required:
//   provider: "circleci", vcs: "github" | "bitbucket", org: "<org-slug>",
//   project: "<repo-name>"
async function runCircleCi(
  token: string,
  config: Record<string, unknown>,
): Promise<ConnectorRunResult> {
  const vcs = String(config.vcs ?? "github");
  const org = String(config.org ?? "");
  const project = String(config.project ?? "");
  const evidence: CollectedEvidence[] = [];
  if (!org || !project) {
    return {
      recordsCollected: 0,
      summary: { provider: "circleci" },
      evidence: [
        {
          dimension: "process",
          signalType: "gap",
          stageHint: 1,
          text: "CircleCI connector missing org/project config — cannot collect pipeline metrics.",
        },
      ],
    };
  }
  const slug = `${vcs}/${org}/${project}`;
  // CircleCI v2 API: list pipelines for the project (paginated). We pull the
  // first 100 to keep the call cheap; over a 30-day window most projects
  // produce well under that.
  const headers = { "Circle-Token": token, Accept: "application/json" };
  const r = await fetch(
    `https://circleci.com/api/v2/project/${encodeURIComponent(slug)}/pipeline?limit=100`,
    { headers },
  );
  if (!r.ok) throw new Error(`CircleCI ${r.status}`);
  const data = (await r.json()) as {
    items: Array<{ id: string; created_at: string; state: string }>;
  };
  const since = Date.now() - 30 * 86_400_000;
  const recent = data.items.filter(
    (p) => new Date(p.created_at).getTime() >= since,
  );

  // For each pipeline, fetch its workflows to determine pass/fail.
  let workflowsTotal = 0;
  let workflowsFailed = 0;
  let workflowsSucceeded = 0;
  for (const p of recent.slice(0, 30)) {
    try {
      const wr = await fetch(
        `https://circleci.com/api/v2/pipeline/${p.id}/workflow`,
        { headers },
      );
      if (!wr.ok) continue;
      const w = (await wr.json()) as {
        items: Array<{ status: string }>;
      };
      workflowsTotal += w.items.length;
      workflowsFailed += w.items.filter(
        (x) => x.status === "failed" || x.status === "failing",
      ).length;
      workflowsSucceeded += w.items.filter((x) => x.status === "success").length;
    } catch {
      // ignore individual pipeline errors
    }
  }

  const summary: Record<string, unknown> = {
    provider: "circleci",
    pipelines30d: recent.length,
    workflows30d: workflowsTotal,
    workflowsSucceeded30d: workflowsSucceeded,
    workflowsFailed30d: workflowsFailed,
    // CircleCI has no incident-issue concept of its own, so MTTR is n/a from
    // this connector. Pair with a Jira/Linear/GitHub connector to fill it.
    mttrHoursAvg: null,
  };
  if (workflowsSucceeded > 0) {
    const deploysPerDay = workflowsSucceeded / 30;
    summary.deploysPerDay = Number(deploysPerDay.toFixed(2));
    evidence.push({
      dimension: "process",
      signalType: deploysPerDay >= 1 ? "strength" : "gap",
      stageHint: deploysPerDay >= 5 ? 5 : deploysPerDay >= 1 ? 4 : 2,
      text: `Deployment frequency (CircleCI ${slug}): ~${deploysPerDay.toFixed(2)} successful workflows/day (30d).`,
    });
  }
  if (workflowsTotal > 0) {
    const cfr = workflowsFailed / workflowsTotal;
    summary.changeFailureRate = Number(cfr.toFixed(3));
    evidence.push({
      dimension: "measurement",
      signalType: cfr <= 0.15 ? "strength" : "gap",
      stageHint: cfr <= 0.15 ? 4 : cfr <= 0.3 ? 3 : 2,
      text: `Change failure rate (CircleCI ${slug}): ${(cfr * 100).toFixed(1)}% (${workflowsFailed}/${workflowsTotal}).`,
    });
  }
  if (workflowsTotal === 0) {
    evidence.push({
      dimension: "process",
      signalType: "gap",
      stageHint: 1,
      text: `No CircleCI workflows found in the last 30 days for ${slug}.`,
    });
  }
  return {
    recordsCollected: workflowsTotal + recent.length,
    summary,
    evidence,
  };
}

// ---- Jenkins -----------------------------------------------------------
// Jenkins exposes a JSON crumb at <baseUrl>/api/json that returns server
// metadata (nodeName, version, jobs[]). We authenticate with HTTP Basic
// (`username:apiToken`) since the API token IS the per-user PAT in Jenkins.
// Read-only API consumption only — we never write back.

interface JenkinsBuild {
  number: number;
  result: string | null;
  timestamp: number;
  duration: number;
}
interface JenkinsJobNode {
  _class?: string;
  name: string;
  jobs?: JenkinsJobNode[];
  builds?: JenkinsBuild[];
}

function isJenkinsFolder(klass: string | undefined): boolean {
  // Common Jenkins container classes that don't have builds of their own
  // but contain nested jobs we should recurse into.
  const k = klass ?? "";
  return (
    k.includes("Folder") ||
    k.includes("WorkflowMultiBranchProject") ||
    k.includes("OrganizationFolder")
  );
}

async function verifyJenkins(
  token: string,
  config: Record<string, unknown>,
): Promise<ConnectorVerifyResult> {
  const baseUrl = String(config.baseUrl ?? "").replace(/\/$/, "");
  const username = String(config.username ?? "");
  if (!baseUrl) return { ok: false, message: "baseUrl required in config" };
  if (!username) return { ok: false, message: "username required in config" };
  if (!token) return { ok: false, message: "API token required" };
  try {
    // SSRF guard: same defense-in-depth pattern as GitLab/Jira — block
    // private hosts before issuing the request even though create/patch
    // already validates baseUrl syntactically.
    await assertSafeUrl(baseUrl);
    const auth = Buffer.from(`${username}:${token}`).toString("base64");
    const r = await fetch(`${baseUrl}/api/json`, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
    });
    if (r.status === 401 || r.status === 403) {
      return {
        ok: false,
        message: `Jenkins auth failed (HTTP ${r.status}). Check username and API token.`,
      };
    }
    if (!r.ok) throw new Error(`Jenkins ${r.status}`);
    const data = (await r.json()) as {
      nodeName?: string;
      jobs?: unknown[];
    };
    const jobCount = Array.isArray(data.jobs) ? data.jobs.length : 0;
    const node = data.nodeName ? ` (node: ${data.nodeName || "master"})` : "";
    return {
      ok: true,
      message: `Authenticated to Jenkins as ${username}${node}`,
      details: { username, jobCount },
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Verify failed" };
  }
}

async function runJenkins(
  token: string,
  config: Record<string, unknown>,
): Promise<ConnectorRunResult> {
  const baseUrl = String(config.baseUrl ?? "").replace(/\/$/, "");
  const username = String(config.username ?? "");
  const jobFilterRaw = String(config.jobFilter ?? "").trim();
  if (!baseUrl || !username) {
    return {
      recordsCollected: 0,
      summary: { provider: "jenkins" },
      evidence: [
        {
          dimension: "process",
          signalType: "gap",
          stageHint: 1,
          text: "Jenkins connector missing baseUrl or username — cannot collect.",
        },
      ],
    };
  }
  await assertSafeUrl(baseUrl);
  let jobFilter: RegExp | null = null;
  if (jobFilterRaw) {
    try {
      jobFilter = new RegExp(jobFilterRaw);
    } catch {
      // Invalid regex falls back to "no filter" rather than failing the run;
      // the assessor still sees the recorded summary.
      jobFilter = null;
    }
  }
  const auth = Buffer.from(`${username}:${token}`).toString("base64");
  const headers = {
    Authorization: `Basic ${auth}`,
    Accept: "application/json",
  };

  // Walk jobs (paginating through folders), accumulating real jobs with
  // their recent builds. Depth is capped to avoid runaway recursion on
  // pathologically nested folder trees.
  const collectedJobs: Array<{ fullName: string; builds: JenkinsBuild[] }> = [];
  const MAX_DEPTH = 5;

  async function walk(url: string, prefix: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    const r = await fetch(
      `${url}/api/json?tree=jobs[name,_class,builds[number,result,timestamp,duration]]`,
      { headers },
    );
    if (!r.ok) {
      // Surface auth/permission failures (and any other non-OK) as a real
      // run failure so it shows up in run history instead of being masked
      // as "no builds found". Matches the other CI/CD providers.
      throw new Error(`Jenkins ${r.status}: ${await r.text()}`);
    }
    const data = (await r.json()) as { jobs?: JenkinsJobNode[] };
    for (const j of data.jobs ?? []) {
      const fullName = prefix ? `${prefix}/${j.name}` : j.name;
      if (isJenkinsFolder(j._class)) {
        await walk(`${url}/job/${encodeURIComponent(j.name)}`, fullName, depth + 1);
      } else {
        if (jobFilter && !jobFilter.test(fullName)) continue;
        collectedJobs.push({
          fullName,
          builds: Array.isArray(j.builds) ? j.builds : [],
        });
      }
    }
  }

  await walk(baseUrl, "", 0);

  // Lookback window matches the other providers (30 days). Builds with
  // `result === null` are still running and excluded from totals.
  const sinceMs = Date.now() - 30 * 86_400_000;
  let total = 0;
  let succeeded = 0;
  let failed = 0;
  let durationSumMs = 0;
  let durationCount = 0;
  for (const j of collectedJobs) {
    for (const b of j.builds) {
      if (typeof b.timestamp !== "number" || b.timestamp < sinceMs) continue;
      if (b.result === null) continue;
      total += 1;
      if (b.result === "SUCCESS") succeeded += 1;
      // CFR per task spec: FAILURE + UNSTABLE ÷ total. ABORTED/NOT_BUILT
      // are excluded from both numerator and "successful deploys" so they
      // don't distort either DORA proxy.
      if (b.result === "FAILURE" || b.result === "UNSTABLE") failed += 1;
      if (typeof b.duration === "number" && b.duration > 0) {
        durationSumMs += b.duration;
        durationCount += 1;
      }
    }
  }

  const evidence: CollectedEvidence[] = [];
  const summary: Record<string, unknown> = {
    provider: "jenkins",
    jobCount: collectedJobs.length,
    builds30d: total,
    buildsSucceeded30d: succeeded,
    buildsFailed30d: failed,
    // Jenkins has no incident concept; MTTR comes from a paired Jira/Linear/
    // GitHub connector.
    mttrHoursAvg: null,
  };

  if (succeeded > 0) {
    const deploysPerDay = succeeded / 30;
    summary.deploysPerDay = Number(deploysPerDay.toFixed(2));
    evidence.push({
      dimension: "process",
      signalType: deploysPerDay >= 1 ? "strength" : "gap",
      stageHint: deploysPerDay >= 5 ? 5 : deploysPerDay >= 1 ? 4 : 2,
      text: `Deployment frequency (Jenkins): ~${deploysPerDay.toFixed(2)} successful builds/day across ${collectedJobs.length} jobs (30d).`,
    });
  }
  if (total > 0) {
    const cfr = failed / total;
    summary.changeFailureRate = Number(cfr.toFixed(3));
    evidence.push({
      dimension: "measurement",
      signalType: cfr <= 0.15 ? "strength" : "gap",
      stageHint: cfr <= 0.15 ? 4 : cfr <= 0.3 ? 3 : 2,
      text: `Change failure rate (Jenkins): ${(cfr * 100).toFixed(1)}% (${failed}/${total} builds FAILURE/UNSTABLE, 30d).`,
    });
  }
  if (durationCount > 0) {
    const avgMin = durationSumMs / durationCount / 60_000;
    summary.buildDurationMinutesAvg = Number(avgMin.toFixed(1));
    // We surface average build duration as the lead-time-style signal
    // because Jenkins has no PR concept of its own — the build IS the
    // deploy, so its duration is the closest proxy to "time to ship".
    summary.leadTimeHoursAvg = Number((avgMin / 60).toFixed(2));
    evidence.push({
      dimension: "process",
      signalType: avgMin <= 30 ? "strength" : "gap",
      stageHint: avgMin <= 10 ? 5 : avgMin <= 30 ? 4 : avgMin <= 60 ? 3 : 2,
      text: `Build duration (Jenkins): avg ${avgMin.toFixed(1)} minutes per build (n=${durationCount}, 30d).`,
    });
  }
  if (total === 0) {
    evidence.push({
      dimension: "process",
      signalType: "gap",
      stageHint: 1,
      text: `No Jenkins builds found in the last 30 days across ${collectedJobs.length} discovered jobs.`,
    });
  }

  return {
    recordsCollected: total + collectedJobs.length,
    summary,
    evidence,
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
  // engineerCount is the denominator for adoption rate. Assessors enter this
  // as part of connector config (or it can come from the People module);
  // when absent, we emit raw counts and an explicit gap.
  const engineerCount = Number(config.engineerCount ?? 0);
  let modelCount = 0;
  let aiUsersCount: number | null = null;
  let aiUsersLabel = "";
  const evidence: CollectedEvidence[] = [];

  if (provider === "openai") {
    const r = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.ok) {
      const data = (await r.json()) as { data: unknown[] };
      modelCount = data.data.length;
    }
    // OpenAI Admin API: count users with org access. This is the single
    // non-survey adoption signal OpenAI exposes (paid endpoint, requires an
    // admin key — silently degrades if the token is a regular project key).
    try {
      const ur = await fetch(
        "https://api.openai.com/v1/organization/users?limit=100",
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (ur.ok) {
        const ud = (await ur.json()) as { data: Array<{ id: string }> };
        aiUsersCount = ud.data.length;
        aiUsersLabel = "OpenAI org members";
      }
    } catch {
      // ignore — non-admin tokens 403 here, which is expected.
    }
  } else if (provider === "anthropic") {
    const r = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": token, "anthropic-version": "2023-06-01" },
    });
    if (r.ok) {
      const data = (await r.json()) as { data: unknown[] };
      modelCount = data.data.length;
    }
    // Anthropic does not expose an organization users endpoint publicly;
    // adoption stays null and we emit a gap that points at the survey.
  }

  evidence.push({
    dimension: "tooling",
    signalType: modelCount > 0 ? "strength" : "gap",
    stageHint: modelCount > 0 ? 3 : 2,
    text: `AI tooling provider "${provider}" configured with ${modelCount} models accessible.`,
  });

  let adoptionPct: number | null = null;
  if (aiUsersCount !== null && engineerCount > 0) {
    adoptionPct = Math.min(100, (aiUsersCount / engineerCount) * 100);
    evidence.push({
      dimension: "people",
      signalType: adoptionPct >= 50 ? "strength" : "gap",
      stageHint: adoptionPct >= 80 ? 5 : adoptionPct >= 50 ? 4 : adoptionPct >= 20 ? 3 : 2,
      text: `AI tool adoption: ~${adoptionPct.toFixed(0)}% (${aiUsersCount} ${aiUsersLabel} / ${engineerCount} engineers).`,
    });
  } else if (aiUsersCount !== null) {
    evidence.push({
      dimension: "people",
      signalType: "quote",
      text: `AI tool reach: ${aiUsersCount} ${aiUsersLabel}. Set engineerCount in connector config to compute adoption %.`,
    });
  } else {
    evidence.push({
      dimension: "people",
      signalType: "gap",
      stageHint: 2,
      text: `AI tool adoption rate not measurable for ${provider} via API alone. Provide an admin token (OpenAI) and engineerCount in config, or rely on the adoption-survey module.`,
    });
  }

  return {
    recordsCollected: modelCount + (aiUsersCount ?? 0),
    summary: {
      provider,
      modelsAvailable: modelCount,
      aiUsersCount,
      engineerCount: engineerCount || null,
      adoptionRatePct: adoptionPct === null ? null : Number(adoptionPct.toFixed(1)),
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
        result = await runLinear(token, cfg);
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
