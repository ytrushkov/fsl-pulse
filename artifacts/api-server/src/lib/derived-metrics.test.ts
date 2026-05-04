import { describe, it, expect } from "vitest";
import {
  classifyCommitMessage,
  deriveMetricsFromInputs,
  type DerivedMetric,
} from "./derived-metrics";

type ConnectorRow = {
  id: string;
  engagementId: string;
  kind: string;
  provider: string;
  // Other fields aren't read by the pure compute pass; cast at the call
  // site to keep the test fixture readable.
};

type RunRow = {
  id: string;
  connectorId: string;
  status: string;
  summary: Record<string, unknown>;
};

function makeInputs(
  fixtures: Array<{ connector: ConnectorRow; run?: RunRow }>,
) {
  const connectors = fixtures.map(({ connector }) => connector);
  const latestByConnector = new Map<string, RunRow>();
  for (const f of fixtures) {
    if (f.run) latestByConnector.set(f.connector.id, f.run);
  }
  return {
    connectors,
    latestByConnector,
  } as Parameters<typeof deriveMetricsFromInputs>[0];
}

function pick(metrics: DerivedMetric[], key: string): DerivedMetric {
  const m = metrics.find((x) => x.key === key);
  if (!m) throw new Error(`metric ${key} missing`);
  return m;
}

describe("deriveMetricsFromInputs", () => {
  it("emits all four metric keys even with no inputs (all degraded)", () => {
    const out = deriveMetricsFromInputs(makeInputs([]));
    expect(out.map((m) => m.key).sort()).toEqual(
      [
        "ai_code_ratio",
        "delivery_efficiency",
        "feedback_loop_speed",
        "investment_split",
      ].sort(),
    );
    for (const m of out) {
      expect(m.value).toBeNull();
      expect(m.stage).toBeNull();
      expect(m.degraded).toBe(true);
      expect(m.notes.length).toBeGreaterThan(0);
      // Even degraded metrics emit a non-empty rationale so the evidence row
      // has searchable text.
      expect(m.rationale.length).toBeGreaterThan(0);
    }
  });

  it("computes AI code ratio as a bounded share of merged code (estimate)", () => {
    const out = deriveMetricsFromInputs(
      makeInputs([
        {
          connector: { id: "ai1", engagementId: "e1", kind: "ai_tooling", provider: "copilot" },
          run: {
            id: "r-ai1",
            connectorId: "ai1",
            status: "success",
            // 60 acceptances / 200 PRs = 30% share — strong but not elite.
            summary: { totalAcceptances: 60, engineerCount: 12 },
          },
        },
        {
          connector: { id: "gh1", engagementId: "e1", kind: "github", provider: "github" },
          run: {
            id: "r-gh1",
            connectorId: "gh1",
            status: "success",
            summary: { prsMerged: 200, prThroughput30d: 200, leadTimeHoursP50: 6 },
          },
        },
      ]),
    );
    const m = pick(out, "ai_code_ratio");
    expect(m.value).toBeCloseTo(0.3, 5);
    expect(m.unit).toBe("% merged code");
    expect(m.display).toContain("%");
    expect(m.display).toContain("estimate");
    expect(m.stage).toBe(4);
    expect(m.signalType).toBe("strength");
    expect(m.degraded).toBe(false);
    expect(m.sourceConnectorIds.sort()).toEqual(["ai1", "gh1"]);
    expect(m.sourceRunIds.sort()).toEqual(["r-ai1", "r-gh1"]);
    expect(m.inputs.totalAcceptances).toBe(60);
    expect(m.inputs.totalPrs).toBe(200);
    expect(m.inputs.acceptancesPerPr).toBeCloseTo(0.3, 5);
    expect(m.inputs.sharePct).toBeCloseTo(30, 1);
  });

  it("caps AI code ratio at 100% share when acceptances exceed merged PRs", () => {
    const out = deriveMetricsFromInputs(
      makeInputs([
        {
          connector: { id: "ai1", engagementId: "e1", kind: "ai_tooling", provider: "copilot" },
          run: {
            id: "r-ai1",
            connectorId: "ai1",
            status: "success",
            summary: { totalAcceptances: 600 },
          },
        },
        {
          connector: { id: "gh1", engagementId: "e1", kind: "github", provider: "github" },
          run: {
            id: "r-gh1",
            connectorId: "gh1",
            status: "success",
            summary: { prThroughput30d: 200 },
          },
        },
      ]),
    );
    const m = pick(out, "ai_code_ratio");
    // 600/200 = 3 acceptances/PR but share saturates at 1.0 (100%).
    expect(m.value).toBe(1);
    expect(m.inputs.sharePct).toBe(100);
    expect(m.inputs.acceptancesPerPr).toBeCloseTo(3, 5);
    expect(m.stage).toBe(5);
    expect(m.signalType).toBe("strength");
    expect(m.notes.some((n) => n.includes("saturates"))).toBe(true);
  });

  it("treats 0 acceptances against >0 merged PRs as a valid 0% reading, not n/a", () => {
    const out = deriveMetricsFromInputs(
      makeInputs([
        {
          connector: { id: "ai1", engagementId: "e1", kind: "ai_tooling", provider: "copilot" },
          run: {
            id: "r-ai1",
            connectorId: "ai1",
            status: "success",
            // Connector ran successfully but the team simply has zero
            // adoption — this is a meaningful "0% AI code" measurement.
            summary: { totalAcceptances: 0 },
          },
        },
        {
          connector: { id: "gh1", engagementId: "e1", kind: "github", provider: "github" },
          run: {
            id: "r-gh1",
            connectorId: "gh1",
            status: "success",
            summary: { prThroughput30d: 80 },
          },
        },
      ]),
    );
    const m = pick(out, "ai_code_ratio");
    expect(m.value).toBe(0);
    expect(m.inputs.sharePct).toBe(0);
    expect(m.stage).toBe(1);
    expect(m.signalType).toBe("gap");
    // Both inputs were present and usable, so the metric is a real
    // measurement — not degraded.
    expect(m.degraded).toBe(false);
    expect(m.display).toContain("0%");
    expect(m.rationale).toContain("0% adoption");
  });

  it("collapses AI code ratio to n/a only when the PR denominator is missing/zero", () => {
    const out = deriveMetricsFromInputs(
      makeInputs([
        {
          connector: { id: "ai1", engagementId: "e1", kind: "ai_tooling", provider: "copilot" },
          run: {
            id: "r-ai1",
            connectorId: "ai1",
            status: "success",
            summary: { totalAcceptances: 50 },
          },
        },
        {
          connector: { id: "gh1", engagementId: "e1", kind: "github", provider: "github" },
          run: {
            id: "r-gh1",
            connectorId: "gh1",
            status: "success",
            summary: { prThroughput30d: 0 },
          },
        },
      ]),
    );
    const m = pick(out, "ai_code_ratio");
    expect(m.value).toBeNull();
    expect(m.degraded).toBe(true);
    expect(m.notes.some((n) => n.includes("0 merged PRs"))).toBe(true);
  });

  it("marks AI code ratio as degraded when source-control is missing", () => {
    const out = deriveMetricsFromInputs(
      makeInputs([
        {
          connector: { id: "ai1", engagementId: "e1", kind: "ai_tooling", provider: "copilot" },
          run: {
            id: "r-ai1",
            connectorId: "ai1",
            status: "success",
            summary: { totalAcceptances: 100 },
          },
        },
      ]),
    );
    const m = pick(out, "ai_code_ratio");
    expect(m.value).toBeNull();
    expect(m.degraded).toBe(true);
    expect(m.notes.some((n) => n.includes("source-control"))).toBe(true);
  });

  it("computes delivery efficiency as PRs / engineer / month", () => {
    const out = deriveMetricsFromInputs(
      makeInputs([
        {
          connector: { id: "ai1", engagementId: "e1", kind: "ai_tooling", provider: "copilot" },
          run: {
            id: "r-ai1",
            connectorId: "ai1",
            status: "success",
            summary: { engineerCount: 10 },
          },
        },
        {
          connector: { id: "gh1", engagementId: "e1", kind: "github", provider: "github" },
          run: {
            id: "r-gh1",
            connectorId: "gh1",
            status: "success",
            summary: { prThroughput30d: 60 },
          },
        },
      ]),
    );
    const m = pick(out, "delivery_efficiency");
    expect(m.value).toBeCloseTo(6, 5);
    expect(m.stage).toBe(4);
    expect(m.signalType).toBe("strength");
    expect(m.degraded).toBe(false);
  });

  it("treats 0 PRs against >0 engineers as a valid 0-output reading, not n/a", () => {
    const out = deriveMetricsFromInputs(
      makeInputs([
        {
          connector: { id: "ai1", engagementId: "e1", kind: "ai_tooling", provider: "copilot" },
          run: {
            id: "r-ai1",
            connectorId: "ai1",
            status: "success",
            summary: { engineerCount: 8 },
          },
        },
        {
          connector: { id: "gh1", engagementId: "e1", kind: "github", provider: "github" },
          run: {
            id: "r-gh1",
            connectorId: "gh1",
            status: "success",
            summary: { prThroughput30d: 0 },
          },
        },
      ]),
    );
    const m = pick(out, "delivery_efficiency");
    // 0 PRs / 8 engineers = 0 PRs/engineer/month — a real measurement,
    // not "n/a".
    expect(m.value).toBe(0);
    expect(m.stage).toBe(1);
    expect(m.signalType).toBe("gap");
    expect(m.degraded).toBe(false);
    expect(m.rationale).toContain("0 merged PRs");
    expect(m.rationale).toContain("0 PRs / engineer / month");
  });

  it("computes feedback loop as composite hours and tolerates partial inputs", () => {
    const full = deriveMetricsFromInputs(
      makeInputs([
        {
          connector: { id: "gh1", engagementId: "e1", kind: "github", provider: "github" },
          run: {
            id: "r-gh1",
            connectorId: "gh1",
            status: "success",
            summary: { leadTimeHoursP50: 8, deploysPerDay: 4, mttrHoursAvg: 2 },
          },
        },
      ]),
    );
    const fullMetric = pick(full, "feedback_loop_speed");
    // 8 + 24/4 + 2 = 16
    expect(fullMetric.value).toBeCloseTo(16, 5);
    expect(fullMetric.stage).toBe(4);
    expect(fullMetric.signalType).toBe("strength");
    expect(fullMetric.degraded).toBe(false);

    const partial = deriveMetricsFromInputs(
      makeInputs([
        {
          connector: { id: "gh1", engagementId: "e1", kind: "github", provider: "github" },
          run: {
            id: "r-gh1",
            connectorId: "gh1",
            status: "success",
            summary: { leadTimeHoursP50: 8 },
          },
        },
      ]),
    );
    const partialMetric = pick(partial, "feedback_loop_speed");
    expect(partialMetric.value).toBeCloseTo(8, 5);
    expect(partialMetric.degraded).toBe(true);
    expect(partialMetric.display).toContain("partial");
  });

  it("computes investment split from issue type distribution alone (degraded — no commits)", () => {
    const out = deriveMetricsFromInputs(
      makeInputs([
        {
          connector: { id: "j1", engagementId: "e1", kind: "jira", provider: "jira" },
          run: {
            id: "r-j1",
            connectorId: "j1",
            status: "success",
            summary: {
              issueTracking: {
                issueTypeDistribution: {
                  bug: 15,
                  feature: 60,
                  tech_debt: 15,
                  chore: 10,
                  other: 0,
                },
              },
            },
          },
        },
      ]),
    );
    const m = pick(out, "investment_split");
    expect(m.value).toBeCloseTo(60, 1);
    expect(m.stage).toBe(4);
    expect(m.signalType).toBe("strength");
    expect(m.inputs.featurePct).toBeCloseTo(60, 1);
    expect(m.inputs.techDebtPct).toBeCloseTo(15, 1);
    expect(m.inputs.bugPct).toBeCloseTo(15, 1);
    expect(m.inputs.issuesClassified).toBe(100);
    expect(m.inputs.commitsClassified).toBe(0);
    // Without a source-control input feeding commit classification, the
    // metric is "degraded" with a clear remediation note (still emits a
    // headline value from the issue-type half).
    expect(m.degraded).toBe(true);
    expect(m.notes.some((n) => n.includes("commit-message"))).toBe(true);
  });

  it("combines issue-type distribution with commit-message classification", () => {
    const out = deriveMetricsFromInputs(
      makeInputs([
        {
          connector: { id: "j1", engagementId: "e1", kind: "jira", provider: "jira" },
          run: {
            id: "r-j1",
            connectorId: "j1",
            status: "success",
            summary: {
              issueTracking: {
                issueTypeDistribution: {
                  bug: 10,
                  feature: 30,
                  tech_debt: 5,
                  chore: 5,
                  other: 0,
                },
              },
            },
          },
        },
        {
          connector: { id: "gh1", engagementId: "e1", kind: "github", provider: "github" },
          run: {
            id: "r-gh1",
            connectorId: "gh1",
            status: "success",
            summary: {
              commitClassification: {
                bug: 20,
                feature: 60,
                tech_debt: 10,
                chore: 10,
                other: 0,
              },
            },
          },
        },
      ]),
    );
    const m = pick(out, "investment_split");
    // Combined: bug 30, feature 90, tech_debt 15, chore 15, other 0 → total 150.
    expect(m.inputs.issuesClassified).toBe(50);
    expect(m.inputs.commitsClassified).toBe(100);
    expect(m.inputs.feature).toBe(90);
    expect(m.inputs.bug).toBe(30);
    expect(m.inputs.featurePct).toBeCloseTo(60, 1);
    expect(m.inputs.bugPct).toBeCloseTo(20, 1);
    expect(m.inputs.commitFeature).toBe(60);
    expect(m.inputs.issueFeature).toBe(30);
    expect(m.degraded).toBe(false);
    expect(m.sourceConnectorIds.sort()).toEqual(["gh1", "j1"]);
    expect(m.rationale).toContain("typed issues");
    expect(m.rationale).toContain("classified commits");
  });

  it("flags bug-storm investment splits as a stage-1 gap", () => {
    const out = deriveMetricsFromInputs(
      makeInputs([
        {
          connector: { id: "j1", engagementId: "e1", kind: "jira", provider: "jira" },
          run: {
            id: "r-j1",
            connectorId: "j1",
            status: "success",
            summary: {
              issueTracking: {
                issueTypeDistribution: {
                  bug: 50,
                  feature: 30,
                  tech_debt: 5,
                  chore: 15,
                  other: 0,
                },
              },
            },
          },
        },
      ]),
    );
    const m = pick(out, "investment_split");
    expect(m.stage).toBe(1);
    expect(m.signalType).toBe("gap");
  });

  it("aggregates multiple source-control connectors into a single share", () => {
    const out = deriveMetricsFromInputs(
      makeInputs([
        {
          connector: { id: "ai1", engagementId: "e1", kind: "ai_tooling", provider: "copilot" },
          run: {
            id: "r-ai1",
            connectorId: "ai1",
            status: "success",
            summary: { totalAcceptances: 25 },
          },
        },
        {
          connector: { id: "gh1", engagementId: "e1", kind: "github", provider: "github" },
          run: {
            id: "r-gh1",
            connectorId: "gh1",
            status: "success",
            summary: { prThroughput30d: 50 },
          },
        },
        {
          connector: { id: "gl1", engagementId: "e1", kind: "gitlab", provider: "gitlab" },
          run: {
            id: "r-gl1",
            connectorId: "gl1",
            status: "success",
            summary: { prsMerged30d: 50 },
          },
        },
      ]),
    );
    const m = pick(out, "ai_code_ratio");
    expect(m.inputs.totalPrs).toBe(100);
    // 25 / 100 = 25% share — emerging.
    expect(m.value).toBeCloseTo(0.25, 5);
    expect(m.inputs.sharePct).toBeCloseTo(25, 1);
    expect(m.stage).toBe(3);
  });
});

describe("classifyCommitMessage", () => {
  it("matches conventional-commit prefixes", () => {
    expect(classifyCommitMessage("feat: add billing dashboard")).toBe("feature");
    expect(classifyCommitMessage("fix(auth): handle expired session")).toBe("bug");
    expect(classifyCommitMessage("fix!: breaking change to API")).toBe("bug");
    expect(classifyCommitMessage("refactor: extract retry helper")).toBe("tech_debt");
    expect(classifyCommitMessage("perf(db): batch invalidation calls")).toBe("tech_debt");
    expect(classifyCommitMessage("docs: README polish")).toBe("chore");
    expect(classifyCommitMessage("test: cover error path")).toBe("chore");
    expect(classifyCommitMessage("ci: bump runner image")).toBe("chore");
    expect(classifyCommitMessage("revert: undo billing fix")).toBe("other");
  });

  it("falls back to keyword matching on free-form subjects", () => {
    expect(classifyCommitMessage("Hotfix login redirect")).toBe("bug");
    expect(classifyCommitMessage("Fixed stale cache invalidation bug")).toBe("bug");
    expect(classifyCommitMessage("Implement onboarding wizard")).toBe("feature");
    expect(classifyCommitMessage("Add inline help to dashboard")).toBe("feature");
    expect(classifyCommitMessage("Bump dependency versions")).toBe("tech_debt");
    expect(classifyCommitMessage("Cleanup legacy migration scripts")).toBe("tech_debt");
    expect(classifyCommitMessage("Update README with new architecture")).toBe("chore");
    expect(classifyCommitMessage("Lint config tweak")).toBe("chore");
  });

  it("returns 'other' for empty / unclassifiable messages", () => {
    expect(classifyCommitMessage("")).toBe("other");
    expect(classifyCommitMessage(null)).toBe("other");
    expect(classifyCommitMessage(undefined)).toBe("other");
    expect(classifyCommitMessage("WIP")).toBe("other");
    expect(classifyCommitMessage("merge branch main")).toBe("other");
  });

  it("only inspects the subject line, ignoring the body", () => {
    const msg = "feat: ship X\n\nfix: ignored body line\nrefactor: also ignored";
    expect(classifyCommitMessage(msg)).toBe("feature");
  });
});
