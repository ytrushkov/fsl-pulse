import type { Dimension } from "./rubric";

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

  // PR review activity heuristic
  let prsReviewed = 0;
  let prsMerged = 0;
  for (const r of repos.slice(0, 5)) {
    try {
      const prs = await ghFetch<Array<{ number: number; merged_at: string | null }>>(
        token,
        `https://api.github.com/repos/${org}/${r.name}/pulls?state=closed&per_page=20`,
      );
      prsReviewed += prs.length;
      prsMerged += prs.filter((p) => p.merged_at).length;
    } catch {
      // ignore
    }
  }
  summary.prsSampled = prsReviewed;
  summary.prsMerged = prsMerged;
  if (prsMerged > 0) {
    evidence.push({
      dimension: "process",
      signalType: "strength",
      stageHint: 3,
      text: `${prsMerged} merged PRs across sampled repos — active code review process.`,
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
    const r = await fetch(`${baseUrl}/api/v4/user`, { headers: { "PRIVATE-TOKEN": token } });
    if (!r.ok) throw new Error(`GitLab ${r.status}`);
    const me = (await r.json()) as { username: string };
    return { ok: true, message: `Authenticated as ${me.username}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Verify failed" };
  }
}

async function runGitlab(
  token: string,
  config: Record<string, unknown>,
): Promise<ConnectorRunResult> {
  const baseUrl = String(config.baseUrl ?? "https://gitlab.com").replace(/\/$/, "");
  const group = String(config.group ?? "");
  const evidence: CollectedEvidence[] = [];
  if (!group)
    return { recordsCollected: 0, summary: { error: "No group configured" }, evidence };
  const r = await fetch(
    `${baseUrl}/api/v4/groups/${encodeURIComponent(group)}/projects?per_page=30`,
    { headers: { "PRIVATE-TOKEN": token } },
  );
  if (!r.ok) throw new Error(`GitLab ${r.status}`);
  const projects = (await r.json()) as Array<{ name: string; id: number }>;
  evidence.push({
    dimension: "tooling",
    signalType: "strength",
    stageHint: 3,
    text: `Discovered ${projects.length} GitLab projects in group ${group}.`,
  });
  return {
    recordsCollected: projects.length,
    summary: { projectCount: projects.length },
    evidence,
  };
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
    const auth = Buffer.from(`${email}:${token}`).toString("base64");
    const r = await fetch(`${baseUrl}/rest/api/3/myself`, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`Jira ${r.status}`);
    const me = (await r.json()) as { displayName: string };
    return { ok: true, message: `Authenticated as ${me.displayName}` };
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
  const auth = Buffer.from(`${email}:${token}`).toString("base64");
  const jql = project ? `project=${project} ORDER BY updated DESC` : "ORDER BY updated DESC";
  const r = await fetch(`${baseUrl}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=50`, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`Jira ${r.status}`);
  const data = (await r.json()) as { total: number; issues: unknown[] };
  return {
    recordsCollected: data.issues.length,
    summary: { totalIssues: data.total, sampleSize: data.issues.length },
    evidence: [
      {
        dimension: "process",
        signalType: "strength",
        stageHint: 2,
        text: `Jira project has ${data.total} tracked issues — formalized planning process.`,
      },
    ],
  };
}

async function verifyLinear(token: string): Promise<ConnectorVerifyResult> {
  if (!token) return { ok: false, message: "Token required" };
  try {
    const r = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({ query: "{ viewer { name email } }" }),
    });
    if (!r.ok) throw new Error(`Linear ${r.status}`);
    const data = (await r.json()) as { data?: { viewer?: { name: string } } };
    if (!data.data?.viewer) throw new Error("Invalid response");
    return { ok: true, message: `Authenticated as ${data.data.viewer.name}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Verify failed" };
  }
}

async function runLinear(token: string): Promise<ConnectorRunResult> {
  const r = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({
      query: `{ issues(first: 50) { nodes { id state { name } } } teams { nodes { id name } } }`,
    }),
  });
  if (!r.ok) throw new Error(`Linear ${r.status}`);
  const data = (await r.json()) as {
    data: {
      issues: { nodes: Array<{ id: string; state: { name: string } }> };
      teams: { nodes: Array<{ id: string; name: string }> };
    };
  };
  const teams = data.data.teams.nodes.length;
  const issues = data.data.issues.nodes.length;
  return {
    recordsCollected: teams + issues,
    summary: { teams, issuesSampled: issues },
    evidence: [
      {
        dimension: "process",
        signalType: "strength",
        stageHint: 3,
        text: `Linear: ${teams} teams, ${issues} issues sampled — modern workflow tooling.`,
      },
    ],
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
  return {
    recordsCollected: 0,
    summary: { provider },
    evidence: [
      {
        dimension: "process",
        signalType: "quote",
        text: `CI/CD connector configured for ${provider}.`,
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
  return {
    recordsCollected: modelCount,
    summary: { provider, modelsAvailable: modelCount },
    evidence: [
      {
        dimension: "tooling",
        signalType: "strength",
        stageHint: modelCount > 0 ? 3 : 2,
        text: `AI tooling provider "${provider}" configured with ${modelCount} models accessible.`,
      },
    ],
  };
}

export async function verifyConnector(
  kind: string,
  provider: string,
  token: string,
  config: Record<string, unknown>,
): Promise<ConnectorVerifyResult> {
  const cfg = { ...config, provider };
  switch (kind) {
    case "github":
      return verifyGithub(token, cfg);
    case "gitlab":
      return verifyGitlab(token, cfg);
    case "jira":
      return verifyJira(token, cfg);
    case "linear":
      return verifyLinear(token);
    case "cicd":
      return verifyCicd(token, cfg);
    case "ai_tooling":
      return verifyAiTooling(token, cfg);
    default:
      return { ok: false, message: `Unknown connector kind: ${kind}` };
  }
}

export async function runConnector(
  kind: string,
  provider: string,
  token: string,
  config: Record<string, unknown>,
): Promise<ConnectorRunResult> {
  const cfg = { ...config, provider };
  switch (kind) {
    case "github":
      return runGithub(token, cfg);
    case "gitlab":
      return runGitlab(token, cfg);
    case "jira":
      return runJira(token, cfg);
    case "linear":
      return runLinear(token);
    case "cicd":
      return runCicd(token, cfg);
    case "ai_tooling":
      return runAiTooling(token, cfg);
    default:
      throw new Error(`Unknown connector kind: ${kind}`);
  }
}
