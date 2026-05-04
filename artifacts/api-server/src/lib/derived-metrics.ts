import { and, desc, eq, inArray, ne } from "drizzle-orm";
import {
  db,
  connectorsTable,
  connectorRunsTable,
  evidenceTable,
} from "@workspace/db";
import { recordActivity, recordSystemActivity } from "./audit";
import { logger } from "./logger";
import type { Request } from "express";

/**
 * Cross-connector derivation layer.
 *
 * Reads the latest successful per-connector run for an engagement and
 * combines them into four headline metrics that are not directly emitted
 * by any single provider:
 *
 *   1. AI code ratio        — Copilot/Cursor acceptances vs merged PRs
 *   2. Delivery efficiency  — merged PRs per engineer-month
 *   3. Feedback loop speed  — composite hours (lead time + deploy gap + MTTR)
 *   4. Investment split     — bug / feature / tech-debt mix from issue tracking
 *
 * Each metric emits a normalized evidence row tagged with the engagement's
 * synthetic "derived_metrics" connector so it shows up in scoring like any
 * other system signal, and a single connector_runs row records the snapshot
 * with provenance pointing back at the source connector_runs that fed it.
 *
 * No new collection happens here — derivation strictly consumes existing
 * connector summaries. Missing inputs degrade the metric to "n/a" with a
 * provenance note rather than failing.
 */

export const DERIVED_KIND = "derived_metrics";
export const DERIVED_PROVIDER = "derived";
export const DERIVED_LABEL = "Derived metrics";

/** Working window for output-side metrics; matches source-control 30d. */
const WINDOW_DAYS = 30;
/** Working hours assumed per engineer per day, for engineer-hour denominators. */
const HOURS_PER_ENGINEER_DAY = 8;

export type DerivedMetricKey =
  | "ai_code_ratio"
  | "delivery_efficiency"
  | "feedback_loop_speed"
  | "investment_split";

export type DerivedDimension = "tooling" | "process" | "measurement";

export interface DerivedMetric {
  key: DerivedMetricKey;
  label: string;
  dimension: DerivedDimension;
  /** Headline numeric value, or null when n/a. */
  value: number | null;
  /** Unit suffix to render after the value. */
  unit: string;
  /** Pre-formatted human display, e.g. "0.42 acceptances / merged PR". */
  display: string;
  /** Maturity stage 1..5, or null when n/a. */
  stage: number | null;
  /** Signal polarity used by scoring + evidence emission. */
  signalType: "strength" | "gap";
  /** Connector ids whose latest run summary fed this metric. */
  sourceConnectorIds: string[];
  /** Specific connector_runs.id values that fed this metric (for click-through). */
  sourceRunIds: string[];
  /** Per-input numeric breakdown so the drawer can show the full calc. */
  inputs: Record<string, number | null>;
  /** Human-readable rationale; this becomes the persisted evidence text. */
  rationale: string;
  /** True when at least one expected input was missing or unusable. */
  degraded: boolean;
  /** Plain-English explanation of every degraded input. */
  notes: string[];
}

export interface DerivedMetricsResult {
  /** Plain-text error message when the snapshot run failed (no metrics persisted). */
  error?: string | null;
  engagementId: string;
  computedAt: string;
  metrics: DerivedMetric[];
  /** The synthetic connector backing this engagement's derived runs. */
  connectorId: string | null;
  /** The connector_runs row this snapshot was written to. */
  runId: string | null;
}

type ConnectorRow = typeof connectorsTable.$inferSelect;
type RunRow = typeof connectorRunsTable.$inferSelect;

/**
 * Idempotent accessor for the per-engagement synthetic connector. Created on
 * demand the first time we derive metrics, kept around afterwards so its
 * connector_runs history is the canonical snapshot history. The synthetic
 * connector carries no token, has scheduling disabled, and is filtered out
 * of the public connectors list so assessors don't see it as something they
 * need to configure.
 */
export async function ensureDerivedConnector(
  engagementId: string,
): Promise<ConnectorRow> {
  const [existing] = await db
    .select()
    .from(connectorsTable)
    .where(
      and(
        eq(connectorsTable.engagementId, engagementId),
        eq(connectorsTable.kind, DERIVED_KIND),
      ),
    )
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(connectorsTable)
    .values({
      engagementId,
      kind: DERIVED_KIND,
      provider: DERIVED_PROVIDER,
      label: DERIVED_LABEL,
      encryptedToken: null,
      config: {},
      status: "configured",
      // Derivation is run as a side-effect of bulk run-all (or on demand);
      // the background scheduler should never pick this up as if it were a
      // third-party API to poll.
      scheduleEnabled: false,
      nextRunAt: null,
    })
    .returning();
  return created;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

interface InputBundle {
  connectors: ConnectorRow[];
  /** Most-recent successful run per source connector. */
  latestByConnector: Map<string, RunRow>;
}

async function loadInputs(engagementId: string): Promise<InputBundle> {
  const connectors = await db
    .select()
    .from(connectorsTable)
    .where(
      and(
        eq(connectorsTable.engagementId, engagementId),
        // Never feed a derivation off itself.
        ne(connectorsTable.kind, DERIVED_KIND),
      ),
    );
  const ids = connectors.map((c) => c.id);
  const latestByConnector = new Map<string, RunRow>();
  if (ids.length === 0) return { connectors, latestByConnector };
  const runs = await db
    .select()
    .from(connectorRunsTable)
    .where(
      and(
        inArray(connectorRunsTable.connectorId, ids),
        eq(connectorRunsTable.status, "success"),
      ),
    )
    .orderBy(desc(connectorRunsTable.startedAt));
  for (const r of runs) {
    if (!latestByConnector.has(r.connectorId)) {
      latestByConnector.set(r.connectorId, r);
    }
  }
  return { connectors, latestByConnector };
}

/** Tag a connector kind/provider tuple by its primary semantic. */
function isSourceControl(c: ConnectorRow): boolean {
  if (c.kind === "github" || c.kind === "gitlab") return true;
  if (c.kind === "azure_devops") return true;
  // CICD providers that share a source-control backend (github_actions,
  // gitlab_ci) reuse the same summary shape and emit prsMerged etc., so
  // they count as source-control inputs as well.
  if (c.kind === "cicd") {
    const p = c.provider;
    return p === "github_actions" || p === "gitlab_ci";
  }
  return false;
}

function isCicd(c: ConnectorRow): boolean {
  // Both first-party CICD connectors and source-control connectors emit
  // deploysPerDay / mttrHoursAvg keys, so we accept either as a CI/CD input
  // for the feedback-loop computation.
  return c.kind === "cicd" || c.kind === "github" || c.kind === "gitlab" || c.kind === "azure_devops";
}

function isAiTooling(c: ConnectorRow): boolean {
  return c.kind === "ai_tooling";
}

function isIssueTracking(c: ConnectorRow): boolean {
  return c.kind === "jira" || c.kind === "linear";
}

interface IssueTypeBucket {
  bug: number;
  feature: number;
  tech_debt: number;
  chore: number;
  other: number;
}

function emptyBucket(): IssueTypeBucket {
  return { bug: 0, feature: 0, tech_debt: 0, chore: 0, other: 0 };
}

function addBuckets(a: IssueTypeBucket, b: IssueTypeBucket): IssueTypeBucket {
  return {
    bug: a.bug + b.bug,
    feature: a.feature + b.feature,
    tech_debt: a.tech_debt + b.tech_debt,
    chore: a.chore + b.chore,
    other: a.other + b.other,
  };
}

function bucketTotal(b: IssueTypeBucket): number {
  return b.bug + b.feature + b.tech_debt + b.chore + b.other;
}

/**
 * Classify a single commit message into the same investment-split buckets
 * as issue-type distribution. Implements the v1 keyword + conventional-commit
 * ruleset from the task spec.
 *
 * Conventional-commit prefix wins when present (`feat:`, `fix(scope)!:`,
 * etc.); otherwise we fall back to whole-word keyword matching on the
 * subject line. Anything we can't classify lands in `other`, which is
 * intentionally excluded from the headline percentages.
 *
 * Exported so tests can pin the rules without going through the full
 * compute path, and so the source-control runners can call it once per
 * fetched commit before discarding the message.
 */
export function classifyCommitMessage(
  message: string | null | undefined,
): keyof IssueTypeBucket {
  if (!message) return "other";
  const subject = message.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!subject) return "other";
  const cc = subject.match(
    /^(feat|fix|refactor|perf|chore|docs|style|test|build|ci|revert)(?:\([^)]*\))?!?:\s/i,
  );
  if (cc) {
    const t = cc[1]?.toLowerCase();
    if (t === "feat") return "feature";
    if (t === "fix") return "bug";
    if (t === "refactor" || t === "perf") return "tech_debt";
    if (
      t === "chore" ||
      t === "docs" ||
      t === "style" ||
      t === "test" ||
      t === "build" ||
      t === "ci"
    )
      return "chore";
    if (t === "revert") return "other";
  }
  const lower = subject.toLowerCase();
  // Keyword fallback — whole-word matches on the subject line. Order
  // matters: "hotfix" should match `bug` before generic "fix" keywords.
  if (/\b(bug(fix)?|hotfix|patch|defect|regression)\b/.test(lower)) return "bug";
  if (/\b(fix(es|ed|ing)?|fixup)\b/.test(lower)) return "bug";
  if (/\b(feat(ure)?s?|implement(s|ed|ing)?|add(s|ed|ing)?)\b/.test(lower))
    return "feature";
  if (
    /\b(refactor(s|ed|ing)?|cleanup|tidy|deps?|dependency|dependencies|upgrade(s|d)?|bump(s|ed)?|migrate(s|d|ion)?|deprecate(s|d)?)\b/.test(
      lower,
    )
  )
    return "tech_debt";
  if (
    /\b(docs?|documentation|readme|test(s|ing)?|spec|lint(er|ing)?|format(ting)?|style|chore|build|ci|workflow)\b/.test(
      lower,
    )
  )
    return "chore";
  return "other";
}

/**
 * Run `classifyCommitMessage` over an array of messages and return the
 * accumulated bucket. Call sites in source-control runners use this to
 * fold per-commit classifications into a single summary field.
 */
export function classifyCommitMessages(
  messages: ReadonlyArray<string | null | undefined>,
): IssueTypeBucket {
  const out = emptyBucket();
  for (const m of messages) {
    out[classifyCommitMessage(m)] += 1;
  }
  return out;
}

/**
 * Pull `summary.commitClassification` from a source-control run. Returns
 * null if the runner didn't emit it (older summaries) or if all buckets
 * are zero.
 */
function readCommitClassification(summary: unknown): IssueTypeBucket | null {
  if (!summary || typeof summary !== "object") return null;
  const cc = (summary as Record<string, unknown>).commitClassification;
  if (!cc || typeof cc !== "object") return null;
  const d = cc as Record<string, unknown>;
  const out = emptyBucket();
  for (const k of ["bug", "feature", "tech_debt", "chore", "other"] as const) {
    const v = num(d[k]);
    if (v !== null) out[k] = v;
  }
  return bucketTotal(out) > 0 ? out : null;
}

/**
 * Pull `summary.issueTracking.issueTypeDistribution` from a Jira/Linear run
 * summary if present. Returns null when the connector hasn't emitted the
 * distribution (e.g. older summary shape) so the caller can skip it.
 */
function readIssueTypeDistribution(summary: unknown): IssueTypeBucket | null {
  if (!summary || typeof summary !== "object") return null;
  const root = summary as Record<string, unknown>;
  const it = root.issueTracking;
  if (!it || typeof it !== "object") return null;
  const dist = (it as Record<string, unknown>).issueTypeDistribution;
  if (!dist || typeof dist !== "object") return null;
  const d = dist as Record<string, unknown>;
  const out = emptyBucket();
  for (const k of ["bug", "feature", "tech_debt", "chore", "other"] as const) {
    const v = num(d[k]);
    if (v !== null) out[k] = v;
  }
  const total = out.bug + out.feature + out.tech_debt + out.chore + out.other;
  return total > 0 ? out : null;
}

// ---- Per-metric computations -----------------------------------------------

function computeAiCodeRatio(input: InputBundle): DerivedMetric {
  let totalAcceptances = 0;
  const aiContributingIds: string[] = [];
  const aiRunIds: string[] = [];
  let aiSeen = false;
  for (const c of input.connectors) {
    if (!isAiTooling(c)) continue;
    const r = input.latestByConnector.get(c.id);
    if (!r) continue;
    aiSeen = true;
    const s = r.summary as Record<string, unknown>;
    const acc = num(s.totalAcceptances);
    if (acc !== null) {
      totalAcceptances += acc;
      aiContributingIds.push(c.id);
      aiRunIds.push(r.id);
    }
  }
  let totalPrs = 0;
  const scContributingIds: string[] = [];
  const scRunIds: string[] = [];
  let scSeen = false;
  for (const c of input.connectors) {
    if (!isSourceControl(c)) continue;
    const r = input.latestByConnector.get(c.id);
    if (!r) continue;
    scSeen = true;
    const s = r.summary as Record<string, unknown>;
    // GitHub uses `prsMerged`, GitLab uses `prsMerged30d`; both source-control
    // runners emit `prThroughput30d` as the count-in-window so prefer that.
    const prs =
      num(s.prThroughput30d) ?? num(s.prsMerged) ?? num(s.prsMerged30d);
    if (prs !== null && prs >= 0) {
      totalPrs += prs;
      scContributingIds.push(c.id);
      scRunIds.push(r.id);
    }
  }
  const sourceConnectorIds = Array.from(
    new Set([...aiContributingIds, ...scContributingIds]),
  );
  const sourceRunIds = Array.from(new Set([...aiRunIds, ...scRunIds]));
  const notes: string[] = [];
  let degraded = false;
  // Mark missing inputs as degraded but DO NOT degrade on legitimate
  // zero measurements: a Copilot run that reports 0 acceptances against a
  // healthy GitHub PR throughput is a meaningful "0% AI adoption" signal,
  // not a missing input.
  if (!aiSeen) {
    notes.push(
      "No AI tooling connector with a successful run — install Copilot/Cursor connector to measure AI acceptances.",
    );
    degraded = true;
  }
  if (!scSeen) {
    notes.push(
      "No source-control connector with a successful run — install GitHub/GitLab connector to count merged PRs.",
    );
    degraded = true;
  }
  let value: number | null = null;
  let stage: number | null = null;
  let signalType: "strength" | "gap" = "gap";
  let display = "n/a";
  let rationale: string;
  // Acceptances-per-PR ratio kept as a secondary diagnostic input.
  let rawRatio: number | null = null;
  let sharePct: number | null = null;
  // We compute a share whenever source-control gave us a non-zero
  // denominator. Zero acceptances against >0 PRs is a *real* 0% reading
  // (stage 1 / gap), not "n/a". The metric only collapses to n/a when
  // the denominator itself is missing or zero, since dividing by zero
  // would be undefined.
  if (scSeen && totalPrs > 0) {
    rawRatio = totalAcceptances / totalPrs;
    // Headline value is "% of merged code touched by AI" — an estimate
    // bounded at 100% because once every shipped PR has at least one AI
    // contribution, additional acceptances stop telling us about *coverage*.
    // Source: PRD §metrics — "share of merged code with AI signals".
    const share = Math.min(1, rawRatio);
    sharePct = share * 100;
    value = share;
    display = `${sharePct.toFixed(0)}% of merged code (estimate)`;
    // Stage thresholds on the bounded share: 50%+ elite, 30%+ strong,
    // 15%+ emerging, >0 trial, =0 absent.
    stage =
      share >= 0.5 ? 5 : share >= 0.3 ? 4 : share >= 0.15 ? 3 : share > 0 ? 2 : 1;
    signalType = share >= 0.3 ? "strength" : "gap";
    if (totalAcceptances === 0 && aiSeen) {
      rationale = `AI code ratio: AI tooling connector reported 0 acceptances against ${totalPrs.toLocaleString()} merged PRs (last ${WINDOW_DAYS}d) → 0% adoption.`;
    } else if (totalAcceptances === 0 && !aiSeen) {
      rationale = `AI code ratio: no AI tooling connector configured (treated as 0 acceptances) against ${totalPrs.toLocaleString()} merged PRs (last ${WINDOW_DAYS}d) → 0% adoption pending an installed AI connector.`;
    } else {
      rationale = `AI code ratio: ${totalAcceptances.toLocaleString()} Copilot/Cursor acceptances against ${totalPrs.toLocaleString()} merged PRs (last ${WINDOW_DAYS}d) → estimated ${sharePct.toFixed(0)}% of merged code touched by AI (acceptances ÷ merged-PRs, capped at 100%).`;
    }
    if (rawRatio > 1) {
      notes.push(
        `Acceptances/PR is ${rawRatio.toFixed(1)} (>1); reported as 100% share since coverage saturates once every PR carries ≥1 AI acceptance.`,
      );
    }
  } else {
    if (scSeen && totalPrs === 0) {
      notes.push(
        "Source-control connector ran but reported 0 merged PRs in the last 30 days — denominator missing, ratio undefined.",
      );
      degraded = true;
    }
    rationale = `AI code ratio n/a — ${notes.join(" ") || "insufficient inputs."}`;
  }
  return {
    key: "ai_code_ratio",
    label: "AI code ratio",
    dimension: "tooling",
    value,
    unit: "% merged code",
    display,
    stage,
    signalType,
    sourceConnectorIds,
    sourceRunIds,
    inputs: {
      totalAcceptances,
      totalPrs,
      acceptancesPerPr: rawRatio,
      sharePct,
    },
    rationale,
    degraded,
    notes,
  };
}

function computeDeliveryEfficiency(input: InputBundle): DerivedMetric {
  let totalPrs = 0;
  const scContributingIds: string[] = [];
  const scRunIds: string[] = [];
  let scSeen = false;
  for (const c of input.connectors) {
    if (!isSourceControl(c)) continue;
    const r = input.latestByConnector.get(c.id);
    if (!r) continue;
    scSeen = true;
    const s = r.summary as Record<string, unknown>;
    const prs =
      num(s.prThroughput30d) ?? num(s.prsMerged) ?? num(s.prsMerged30d);
    if (prs !== null && prs >= 0) {
      totalPrs += prs;
      scContributingIds.push(c.id);
      scRunIds.push(r.id);
    }
  }
  // Engineer count is reported by the AI tooling connector (it's the
  // "denominator of seats" used for adoption math). Use the max across
  // ai_tooling connectors so two providers configured on overlapping orgs
  // don't double-count engineers.
  let engineers = 0;
  let engineersSeen = false;
  const engContributingIds: string[] = [];
  const engRunIds: string[] = [];
  for (const c of input.connectors) {
    if (!isAiTooling(c)) continue;
    const r = input.latestByConnector.get(c.id);
    if (!r) continue;
    const s = r.summary as Record<string, unknown>;
    const e = num(s.engineerCount);
    if (e !== null && e > 0) {
      engineersSeen = true;
      engineers = Math.max(engineers, e);
      engContributingIds.push(c.id);
      engRunIds.push(r.id);
    }
  }
  const sourceConnectorIds = Array.from(
    new Set([...scContributingIds, ...engContributingIds]),
  );
  const sourceRunIds = Array.from(new Set([...scRunIds, ...engRunIds]));
  const notes: string[] = [];
  let degraded = false;
  // Mark missing inputs as degraded but DO NOT degrade on a legitimate
  // zero PR throughput: a source-control connector that ran successfully
  // and reported 0 merged PRs against a known engineer headcount is a
  // meaningful "zero output" signal (stage 1 / gap), not "n/a".
  if (!scSeen) {
    notes.push(
      "No source-control connector with a successful run — install GitHub/GitLab to measure shipped PRs.",
    );
    degraded = true;
  }
  if (!engineersSeen) {
    notes.push(
      "Engineer count missing — set engineerCount on an AI tooling connector (or install one) to compute the per-engineer denominator.",
    );
    degraded = true;
  }
  let value: number | null = null;
  let stage: number | null = null;
  let signalType: "strength" | "gap" = "gap";
  let display = "n/a";
  let rationale: string;
  // Engineers > 0 is the only required denominator; we can compute a
  // valid 0 PRs/engineer/month if source-control ran and shipped nothing.
  if (engineers > 0 && scSeen) {
    value = totalPrs / engineers;
    display = `${value.toFixed(1)} PRs / engineer / month`;
    const engineerHours = engineers * WINDOW_DAYS * HOURS_PER_ENGINEER_DAY;
    // Per-engineer-month thresholds: 5+ is healthy, 15+ is elite,
    // <2 indicates a delivery bottleneck or undercount, 0 is a stage-1
    // gap (no output observed in the window).
    stage =
      value >= 15
        ? 5
        : value >= 5
          ? 4
          : value >= 2
            ? 3
            : value >= 0.5
              ? 2
              : 1;
    signalType = value >= 5 ? "strength" : "gap";
    rationale =
      totalPrs === 0
        ? `Delivery efficiency: 0 merged PRs across ${engineers} engineers in the last ${WINDOW_DAYS}d → 0 PRs / engineer / month (no output observed; ≈${engineerHours.toLocaleString()} engineer-hours of capacity were available).`
        : `Delivery efficiency: ${totalPrs.toLocaleString()} merged PRs across ${engineers} engineers in the last ${WINDOW_DAYS}d → ${value.toFixed(1)} PRs / engineer / month (≈${engineerHours.toLocaleString()} engineer-hours of capacity).`;
  } else {
    rationale = `Delivery efficiency n/a — ${notes.join(" ") || "insufficient inputs."}`;
  }
  return {
    key: "delivery_efficiency",
    label: "Delivery efficiency",
    dimension: "process",
    value,
    unit: "PRs/engineer/month",
    display,
    stage,
    signalType,
    sourceConnectorIds,
    sourceRunIds,
    inputs: { totalPrs, engineers },
    rationale,
    degraded,
    notes,
  };
}

function computeFeedbackLoopSpeed(input: InputBundle): DerivedMetric {
  // Composite hours: PR open → merge (lead time p50) + average gap between
  // successful deploys (24/deploysPerDay) + MTTR after a deploy fails.
  const leadTimes: number[] = [];
  const deployRates: number[] = [];
  const mttrs: number[] = [];
  const contribIds = new Set<string>();
  const contribRunIds = new Set<string>();
  for (const c of input.connectors) {
    const r = input.latestByConnector.get(c.id);
    if (!r) continue;
    const s = r.summary as Record<string, unknown>;
    let used = false;
    if (isSourceControl(c)) {
      // Prefer p50 (less outlier-sensitive than the avg).
      const p50 = num(s.leadTimeHoursP50) ?? num(s.leadTimeHoursAvg);
      if (p50 !== null && p50 >= 0) {
        leadTimes.push(p50);
        used = true;
      }
    }
    if (isCicd(c)) {
      const dpd = num(s.deploysPerDay);
      if (dpd !== null && dpd > 0) {
        deployRates.push(dpd);
        used = true;
      }
    }
    const mttr = num(s.mttrHoursAvg);
    if (mttr !== null && mttr > 0) {
      mttrs.push(mttr);
      used = true;
    }
    if (used) {
      contribIds.add(c.id);
      contribRunIds.add(r.id);
    }
  }
  // Aggregate inputs: average lead-time across providers, max deploy rate
  // (whichever pipeline ships the most), average MTTR.
  const leadTimeP50 =
    leadTimes.length > 0
      ? leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length
      : null;
  const deploysPerDay =
    deployRates.length > 0 ? Math.max(...deployRates) : null;
  const mttrHours =
    mttrs.length > 0 ? mttrs.reduce((a, b) => a + b, 0) / mttrs.length : null;
  const deployIntervalH =
    deploysPerDay !== null && deploysPerDay > 0 ? 24 / deploysPerDay : null;
  const notes: string[] = [];
  let degraded = false;
  if (leadTimeP50 === null) {
    notes.push(
      "No source-control lead-time signal — install GitHub/GitLab to measure PR open→merge.",
    );
    degraded = true;
  }
  if (deployIntervalH === null) {
    notes.push(
      "No deploy frequency signal — install a CI/CD or source-control connector that emits deploysPerDay.",
    );
    degraded = true;
  }
  if (mttrHours === null) {
    notes.push(
      "No MTTR signal — install a CI/CD or issue-tracking connector that emits mttrHoursAvg (tag incidents with 'incident' or 'p0').",
    );
    degraded = true;
  }
  let value: number | null = null;
  let stage: number | null = null;
  let signalType: "strength" | "gap" = "gap";
  let display = "n/a";
  let rationale: string;
  // Even with one or two of the three terms we still produce a partial
  // composite — the headline is just lower-bounded and we mark it degraded.
  const parts = [leadTimeP50, deployIntervalH, mttrHours].filter(
    (n): n is number => n !== null,
  );
  if (parts.length > 0) {
    value = parts.reduce((a, b) => a + b, 0);
    display = `${value.toFixed(1)} hours${degraded ? " (partial)" : ""}`;
    // Composite stages: <12h elite, 12–48 healthy, 48–168 typical,
    // 168–336 slow, ≥336 critical.
    stage =
      value <= 12 ? 5 : value <= 48 ? 4 : value <= 168 ? 3 : value <= 336 ? 2 : 1;
    signalType = value <= 48 ? "strength" : "gap";
    const breakdown: string[] = [];
    if (leadTimeP50 !== null) breakdown.push(`lead-time p50 ${leadTimeP50.toFixed(1)}h`);
    if (deployIntervalH !== null)
      breakdown.push(
        `deploy interval ${deployIntervalH.toFixed(1)}h (${(deploysPerDay ?? 0).toFixed(2)}/day)`,
      );
    if (mttrHours !== null) breakdown.push(`MTTR ${mttrHours.toFixed(1)}h`);
    rationale = `Feedback loop speed: ${value.toFixed(1)}h composite — ${breakdown.join(" + ")}.`;
  } else {
    rationale = `Feedback loop speed n/a — ${notes.join(" ") || "insufficient inputs."}`;
  }
  return {
    key: "feedback_loop_speed",
    label: "Feedback loop speed",
    dimension: "measurement",
    value,
    unit: "hours",
    display,
    stage,
    signalType,
    sourceConnectorIds: Array.from(contribIds),
    sourceRunIds: Array.from(contribRunIds),
    inputs: {
      leadTimeP50,
      deployIntervalHours: deployIntervalH,
      deploysPerDay,
      mttrHours,
    },
    rationale,
    degraded,
    notes,
  };
}

function computeInvestmentSplit(input: InputBundle): DerivedMetric {
  // Per task spec, investment split combines two independent inputs into
  // a single bug / feature / tech-debt / chore distribution:
  //   1. issue-type distribution from Jira / Linear (one row per resolved
  //      issue in the last 30d)
  //   2. commit-message classification from the source-control runners
  //      (each commit's subject classified via the v1 conventional-commit +
  //      keyword ruleset; see `classifyCommitMessage`).
  // Each input is summed into its own bucket so we can show the contribution
  // breakdown in the rationale, then added together to produce the headline
  // distribution.
  let issueTotals = emptyBucket();
  let commitTotals = emptyBucket();
  const contribIds: string[] = [];
  const contribRunIds: string[] = [];
  let trackerSeen = false;
  let scSeen = false;
  let commitsClassified = 0;
  for (const c of input.connectors) {
    if (isIssueTracking(c)) {
      const r = input.latestByConnector.get(c.id);
      if (!r) continue;
      trackerSeen = true;
      const dist = readIssueTypeDistribution(r.summary);
      if (!dist) continue;
      issueTotals = addBuckets(issueTotals, dist);
      contribIds.push(c.id);
      contribRunIds.push(r.id);
      continue;
    }
    if (isSourceControl(c)) {
      const r = input.latestByConnector.get(c.id);
      if (!r) continue;
      scSeen = true;
      const cls = readCommitClassification(r.summary);
      if (!cls) continue;
      commitTotals = addBuckets(commitTotals, cls);
      commitsClassified += bucketTotal(cls);
      contribIds.push(c.id);
      contribRunIds.push(r.id);
    }
  }
  const totals = addBuckets(issueTotals, commitTotals);
  const total = bucketTotal(totals);
  const issueTotal = bucketTotal(issueTotals);
  const notes: string[] = [];
  let degraded = false;
  if (!trackerSeen) {
    notes.push(
      "No issue tracking connector with a successful run — install Jira/Linear to feed issue-type distribution.",
    );
    degraded = true;
  } else if (issueTotal === 0) {
    notes.push(
      "Issue tracking connector ran but no typed issues were resolved in the last 30d.",
    );
    degraded = true;
  }
  if (!scSeen) {
    notes.push(
      "No source-control connector with a successful run — install GitHub/GitLab to feed commit-message classification.",
    );
    degraded = true;
  } else if (commitsClassified === 0) {
    notes.push(
      "Source-control connector ran but no commit messages were classifiable in the last 30d (older runs may pre-date commit classification).",
    );
    degraded = true;
  }
  let value: number | null = null;
  let stage: number | null = null;
  let signalType: "strength" | "gap" = "gap";
  let display = "n/a";
  let rationale: string;
  let featurePct = 0;
  let techDebtPct = 0;
  let bugPct = 0;
  if (total > 0) {
    featurePct = (totals.feature / total) * 100;
    techDebtPct = (totals.tech_debt / total) * 100;
    bugPct = (totals.bug / total) * 100;
    // Headline value = feature share %. Lower-numbered stages flag both
    // extremes (feature-only with no tech-debt invest, or bug-storm).
    value = featurePct;
    display = `${featurePct.toFixed(0)}% feature · ${techDebtPct.toFixed(0)}% tech-debt · ${bugPct.toFixed(0)}% bug`;
    if (bugPct >= 30) {
      stage = 1;
      signalType = "gap";
    } else if (techDebtPct >= 30) {
      stage = 2;
      signalType = "gap";
    } else if (featurePct >= 50 && featurePct <= 70 && techDebtPct >= 10) {
      stage = 4;
      signalType = "strength";
    } else if (featurePct > 80) {
      stage = 3;
      signalType = "gap";
    } else if (featurePct >= 40) {
      stage = 3;
      signalType = "strength";
    } else {
      stage = 2;
      signalType = "gap";
    }
    const breakdown: string[] = [];
    if (issueTotal > 0)
      breakdown.push(
        `${issueTotal.toLocaleString()} typed issues (Jira/Linear)`,
      );
    if (commitsClassified > 0)
      breakdown.push(
        `${commitsClassified.toLocaleString()} classified commits (GitHub/GitLab)`,
      );
    rationale = `Investment split: ${featurePct.toFixed(0)}% feature / ${techDebtPct.toFixed(0)}% tech-debt / ${bugPct.toFixed(0)}% bug across ${breakdown.join(" + ") || `${total.toLocaleString()} signals`} (last 30d).`;
  } else {
    rationale = `Investment split n/a — ${notes.join(" ") || "no typed issues or classified commits in window."}`;
  }
  return {
    key: "investment_split",
    label: "Investment split",
    dimension: "measurement",
    value,
    unit: "% feature",
    display,
    stage,
    signalType,
    sourceConnectorIds: contribIds,
    sourceRunIds: contribRunIds,
    inputs: {
      bug: totals.bug,
      feature: totals.feature,
      tech_debt: totals.tech_debt,
      chore: totals.chore,
      other: totals.other,
      issuesClassified: issueTotal,
      commitsClassified,
      issueBug: issueTotals.bug,
      issueFeature: issueTotals.feature,
      issueTechDebt: issueTotals.tech_debt,
      issueChore: issueTotals.chore,
      commitBug: commitTotals.bug,
      commitFeature: commitTotals.feature,
      commitTechDebt: commitTotals.tech_debt,
      commitChore: commitTotals.chore,
      featurePct: total > 0 ? Number(featurePct.toFixed(1)) : null,
      techDebtPct: total > 0 ? Number(techDebtPct.toFixed(1)) : null,
      bugPct: total > 0 ? Number(bugPct.toFixed(1)) : null,
    },
    rationale,
    degraded,
    notes,
  };
}

/**
 * Pure compute pass — exposed separately from `runDerivedMetrics` so unit
 * tests can pass an in-memory `InputBundle` and assert on the metric shape
 * without touching the database.
 */
export function deriveMetricsFromInputs(input: InputBundle): DerivedMetric[] {
  return [
    computeAiCodeRatio(input),
    computeDeliveryEfficiency(input),
    computeFeedbackLoopSpeed(input),
    computeInvestmentSplit(input),
  ];
}

/**
 * Compute the four derived metrics for an engagement without writing to the
 * database. Used by the GET endpoint as a "fresh preview" path and by tests.
 */
export async function computeDerivedMetrics(
  engagementId: string,
): Promise<{ metrics: DerivedMetric[] }> {
  const inputs = await loadInputs(engagementId);
  return { metrics: deriveMetricsFromInputs(inputs) };
}

interface RunOpts {
  trigger: "manual" | "bulk" | "scheduler";
  req?: Request;
  requestId?: string;
}

/**
 * Compute, persist, and audit a derived-metrics snapshot for an engagement.
 *
 * Writes one connector_runs row keyed to the engagement's synthetic
 * "derived_metrics" connector, replaces any prior derived-evidence rows so
 * the latest snapshot is the only one scoring sees, and emits a single
 * `derived_metrics_run` audit event with the per-metric outcomes.
 */
export async function runDerivedMetrics(
  engagementId: string,
  opts: RunOpts,
): Promise<DerivedMetricsResult> {
  const connector = await ensureDerivedConnector(engagementId);
  const sourceRef = `${DERIVED_KIND}:${DERIVED_PROVIDER}:${connector.id}`;

  const [run] = await db
    .insert(connectorRunsTable)
    .values({ connectorId: connector.id, status: "running" })
    .returning();
  await db
    .update(connectorsTable)
    .set({ status: "collecting", lastRunAt: new Date(), lastError: null })
    .where(eq(connectorsTable.id, connector.id));

  const audit = async (
    input: Parameters<typeof recordSystemActivity>[0],
  ): Promise<void> => {
    if (opts.req) {
      await recordActivity(opts.req, input);
    } else {
      await recordSystemActivity({ ...input, requestId: opts.requestId });
    }
  };

  try {
    const inputs = await loadInputs(engagementId);
    const metrics = deriveMetricsFromInputs(inputs);
    const computedAt = new Date();

    // Replace the previous derived-evidence snapshot so scoring sees one
    // current set of derived rows, not an accumulating history. (Per-provider
    // connectors append because their evidence is per-run; derived rows are a
    // computed snapshot whose stale predecessor isn't useful.)
    await db
      .delete(evidenceTable)
      .where(
        and(
          eq(evidenceTable.engagementId, engagementId),
          eq(evidenceTable.sourceRef, sourceRef),
        ),
      );

    if (metrics.length > 0) {
      await db.insert(evidenceTable).values(
        metrics.map((m) => ({
          engagementId,
          sourceType: "system" as const,
          sourceRef,
          dimension: m.dimension,
          signalType: m.signalType,
          stageHint: m.stage ?? null,
          text: m.rationale,
          createdBy: "system",
        })),
      );
    }

    const summary = {
      computedAt: computedAt.toISOString(),
      metrics,
      // Provenance for the connector_runs.summary blob — this is what the
      // signals drawer reads back to show "which underlying runs fed it".
      sourceRunIds: Array.from(
        new Set(metrics.flatMap((m) => m.sourceRunIds)),
      ),
      sourceConnectorIds: Array.from(
        new Set(metrics.flatMap((m) => m.sourceConnectorIds)),
      ),
      // recordsCollected is mirrored on the run row but echoing it here keeps
      // the summary self-describing for ad-hoc inspection.
      recordsCollected: metrics.length,
    };

    const [updated] = await db
      .update(connectorRunsTable)
      .set({
        status: "success",
        finishedAt: new Date(),
        recordsCollected: metrics.length,
        summary,
      })
      .where(eq(connectorRunsTable.id, run.id))
      .returning();
    await db
      .update(connectorsTable)
      .set({
        status: "collected",
        lastRunAt: new Date(),
        lastSuccessAt: new Date(),
        lastError: null,
      })
      .where(eq(connectorsTable.id, connector.id));

    const summaryLine = metrics
      .map((m) => `${m.label}: ${m.display}`)
      .join("; ");
    await audit({
      engagementId,
      kind: "derived_metrics_run",
      message: `Derived metrics computed (${opts.trigger}): ${summaryLine}`,
      payload: {
        connectorId: connector.id,
        runId: run.id,
        trigger: opts.trigger,
        metricCount: metrics.length,
        degraded: metrics.filter((m) => m.degraded).map((m) => m.key),
      },
    });

    return {
      engagementId,
      computedAt: (updated?.finishedAt ?? computedAt).toISOString(),
      metrics,
      connectorId: connector.id,
      runId: run.id,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err, engagementId }, "derived metrics run failed");
    await db
      .update(connectorRunsTable)
      .set({ status: "failed", finishedAt: new Date(), error: msg })
      .where(eq(connectorRunsTable.id, run.id));
    await db
      .update(connectorsTable)
      .set({ status: "failed", lastError: msg })
      .where(eq(connectorsTable.id, connector.id));
    await audit({
      engagementId,
      kind: "derived_metrics_run_failed",
      severity: "critical",
      message: `Derived metrics computation failed: ${msg}`,
      payload: { connectorId: connector.id, runId: run.id, trigger: opts.trigger, error: msg },
    });
    return {
      engagementId,
      computedAt: new Date().toISOString(),
      metrics: [],
      connectorId: connector.id,
      runId: run.id,
      // Surface the underlying error so the route handler can return a
      // non-success status — otherwise the UI can't tell a true compute
      // failure apart from a degraded-but-empty snapshot.
      error: msg,
    };
  }
}

/**
 * Fetch the most recent persisted derived-metrics snapshot for an engagement.
 * Returns null when derivation has never run. Used by the GET endpoint so the
 * overview tile can render the last snapshot without recomputing.
 */
export async function getLatestDerivedMetrics(
  engagementId: string,
): Promise<DerivedMetricsResult | null> {
  const [connector] = await db
    .select()
    .from(connectorsTable)
    .where(
      and(
        eq(connectorsTable.engagementId, engagementId),
        eq(connectorsTable.kind, DERIVED_KIND),
      ),
    )
    .limit(1);
  if (!connector) return null;
  const [latest] = await db
    .select()
    .from(connectorRunsTable)
    .where(
      and(
        eq(connectorRunsTable.connectorId, connector.id),
        eq(connectorRunsTable.status, "success"),
      ),
    )
    .orderBy(desc(connectorRunsTable.startedAt))
    .limit(1);
  if (!latest) return null;
  const summary = (latest.summary ?? {}) as Record<string, unknown>;
  const metrics = Array.isArray(summary.metrics)
    ? (summary.metrics as DerivedMetric[])
    : [];
  return {
    engagementId,
    computedAt: (latest.finishedAt ?? latest.startedAt).toISOString(),
    metrics,
    connectorId: connector.id,
    runId: latest.id,
  };
}
