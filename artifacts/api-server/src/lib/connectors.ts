import { eq } from "drizzle-orm";
import { db, artifactDocsTable } from "@workspace/db";
import type { Dimension } from "./rubric";
import { assertSafeUrlResolved } from "./util";
import { logger } from "./logger";
import {
  bucketTimeInStatus,
  classifyIssueType,
  classifyStatus,
  emptyIssueTypeDistribution,
  readStatusMappingFromConfig,
  type CanonicalIssueType,
  type IssueTypeDistribution,
  type PercentileTriple,
} from "./metrics";
import {
  bucketPrSizes,
  branchLifespanStats,
  busFactor,
  detailSampleSize,
  emptySizeDistribution,
  percentiles as scPercentiles,
  reworkRate,
  type PrSizeDistribution,
} from "./connector-metrics";


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
 * Lookback window applied to all source-control metrics. PRD §6.2 talks
 * in months but anchoring on 30 days keeps deploy-frequency / CFR
 * comparable to the existing DORA proxies and bounds the per-run cost
 * of the deeper-detail sample.
 */
const SC_LOOKBACK_DAYS = 30;

/**
 * Hard cap on per-PR / per-MR deep-dive calls per run, on top of
 * detailSampleSize(). Each deep-dive PR costs 3 extra API calls
 * (detail + reviews + commits), so 30 PRs ≈ 90 extra calls per run on
 * top of the workflow / pipeline / list calls. This keeps total run
 * cost predictable even on very chatty repos / groups.
 */
const SC_DETAIL_HARD_CAP = 30;

/**
 * Shape collected per-PR / per-MR for the source-control metric block,
 * shared by GitHub and GitLab so the helper functions can produce
 * provider-identical output.
 */
interface ScPrDetail {
  /** Open → merge in ms (defined for merged PRs/MRs only). */
  leadTimeMs: number;
  /** First review submitted_at − created_at, or null if no review yet. */
  timeToFirstReviewMs: number | null;
  /** First review → merge, captures the “final approval cycle” turnaround. */
  reviewTurnaroundMs: number | null;
  /** Total number of review submissions / approvals on the PR. */
  reviewIterations: number;
  /** All review-style comments on the PR (issue comments + inline). */
  commentCount: number;
  /** additions + deletions for the size-bucket distribution. */
  linesChanged: number;
  /** Commits authored *after* the first review submitted_at. */
  commitsAfterFirstReview: number;
  /** First commit on the source branch and merged_at, for branch lifespan. */
  firstCommitMs: number | null;
  mergedAtMs: number;
}

/**
 * Compute the canonical source-control metric block from the deep-dive
 * sample plus org-wide aggregates. Both runners call this so the
 * resulting summary keys are byte-for-byte identical across providers.
 */
function buildSourceControlSummary(args: {
  prDetails: ScPrDetail[];
  /** All merged PR/MR lead-time durations in the window (not just sampled). */
  allLeadTimesMs: number[];
  authorCommitCounts: Record<string, number>;
  totalCommitsInWindow: number;
  prsInWindow: number;
  /**
   * Number of merged PRs the runner attempted to fetch detail for. May be
   * higher than `prDetails.length` if some per-PR calls failed (counted
   * separately so the UI can show "sampled N of M (k succeeded)").
   */
  prsAttemptedForDetail: number;
}): {
  summary: Record<string, unknown>;
  evidence: CollectedEvidence[];
} {
  const summary: Record<string, unknown> = {};
  const evidence: CollectedEvidence[] = [];

  // Throughput — merged PR/MR count in the window. Always emit a
  // dedicated process-dimension evidence row (including n=0) so the
  // scoring engine sees one normalized row per metric.
  summary.prThroughput30d = args.prsInWindow;
  {
    const perDay = args.prsInWindow / SC_LOOKBACK_DAYS;
    evidence.push({
      dimension: "process",
      signalType:
        args.prsInWindow === 0 ? "gap" : perDay >= 1 ? "strength" : "gap",
      stageHint:
        args.prsInWindow === 0
          ? 1
          : perDay >= 5
            ? 5
            : perDay >= 1
              ? 4
              : perDay >= 0.2
                ? 3
                : 2,
      text:
        args.prsInWindow === 0
          ? `PR throughput n/a — no merged PRs/MRs in the last ${SC_LOOKBACK_DAYS} days.`
          : `PR throughput: ${args.prsInWindow} merged PRs/MRs in the last ${SC_LOOKBACK_DAYS} days (~${perDay.toFixed(2)}/day).`,
    });
  }

  // PR lead-time percentiles (uses ALL merged PRs, not just sampled).
  const leadStats = scPercentiles(args.allLeadTimesMs);
  if (leadStats.n > 0) {
    summary.leadTimeHoursP50 = leadStats.p50 ? round1(leadStats.p50 / 3_600_000) : null;
    summary.leadTimeHoursP75 = leadStats.p75 ? round1(leadStats.p75 / 3_600_000) : null;
    summary.leadTimeHoursP95 = leadStats.p95 ? round1(leadStats.p95 / 3_600_000) : null;
    evidence.push({
      dimension: "process",
      signalType: (summary.leadTimeHoursP75 as number) <= 72 ? "strength" : "gap",
      stageHint:
        (summary.leadTimeHoursP75 as number) <= 24
          ? 5
          : (summary.leadTimeHoursP75 as number) <= 72
            ? 4
            : (summary.leadTimeHoursP75 as number) <= 168
              ? 3
              : 2,
      text: `PR lead time percentiles: p50 ${summary.leadTimeHoursP50}h · p75 ${summary.leadTimeHoursP75}h · p95 ${summary.leadTimeHoursP95}h (n=${leadStats.n}, ${SC_LOOKBACK_DAYS}d).`,
    });
  } else {
    summary.leadTimeHoursP50 = null;
    summary.leadTimeHoursP75 = null;
    summary.leadTimeHoursP95 = null;
    evidence.push({
      dimension: "process",
      signalType: "gap",
      stageHint: 1,
      text: `PR lead time n/a — no merged PRs/MRs in the last ${SC_LOOKBACK_DAYS} days.`,
    });
  }

  // Time-to-first-review and review turnaround — from the deep-dive
  // sample (we'd otherwise need an extra call per merged PR org-wide).
  const ttfrSample = args.prDetails
    .map((p) => p.timeToFirstReviewMs)
    .filter((d): d is number => d !== null && d > 0);
  if (ttfrSample.length > 0) {
    const ttfr = scPercentiles(ttfrSample);
    summary.timeToFirstReviewHoursP50 = ttfr.p50 ? round1(ttfr.p50 / 3_600_000) : null;
    summary.timeToFirstReviewHoursP75 = ttfr.p75 ? round1(ttfr.p75 / 3_600_000) : null;
    summary.timeToFirstReviewHoursP95 = ttfr.p95 ? round1(ttfr.p95 / 3_600_000) : null;
    evidence.push({
      dimension: "process",
      signalType:
        (summary.timeToFirstReviewHoursP75 as number) <= 24 ? "strength" : "gap",
      stageHint:
        (summary.timeToFirstReviewHoursP75 as number) <= 4
          ? 5
          : (summary.timeToFirstReviewHoursP75 as number) <= 24
            ? 4
            : (summary.timeToFirstReviewHoursP75 as number) <= 72
              ? 3
              : 2,
      text: `Time to first review: p50 ${summary.timeToFirstReviewHoursP50}h · p75 ${summary.timeToFirstReviewHoursP75}h · p95 ${summary.timeToFirstReviewHoursP95}h (n=${ttfr.n}).`,
    });
  } else {
    summary.timeToFirstReviewHoursP50 = null;
    summary.timeToFirstReviewHoursP75 = null;
    summary.timeToFirstReviewHoursP95 = null;
    evidence.push({
      dimension: "process",
      signalType: "gap",
      stageHint: 1,
      text: "Time to first review n/a — no reviewed PRs in the deep-dive sample.",
    });
  }

  // Review turnaround (first review → merge). Each new metric must
  // emit either populated evidence or an explicit gap row so the
  // scoring engine sees consistent rows regardless of provider.
  const turnaroundSample = args.prDetails
    .map((p) => p.reviewTurnaroundMs)
    .filter((d): d is number => d !== null && d > 0);
  if (turnaroundSample.length > 0) {
    const ta = scPercentiles(turnaroundSample);
    summary.reviewTurnaroundHoursP50 = ta.p50 ? round1(ta.p50 / 3_600_000) : null;
    summary.reviewTurnaroundHoursP75 = ta.p75 ? round1(ta.p75 / 3_600_000) : null;
    summary.reviewTurnaroundHoursP95 = ta.p95 ? round1(ta.p95 / 3_600_000) : null;
    evidence.push({
      dimension: "process",
      signalType:
        (summary.reviewTurnaroundHoursP75 as number) <= 24 ? "strength" : "gap",
      stageHint:
        (summary.reviewTurnaroundHoursP75 as number) <= 4
          ? 5
          : (summary.reviewTurnaroundHoursP75 as number) <= 24
            ? 4
            : (summary.reviewTurnaroundHoursP75 as number) <= 72
              ? 3
              : 2,
      text: `Review turnaround: p50 ${summary.reviewTurnaroundHoursP50}h · p75 ${summary.reviewTurnaroundHoursP75}h · p95 ${summary.reviewTurnaroundHoursP95}h (n=${ta.n}).`,
    });
  } else {
    summary.reviewTurnaroundHoursP50 = null;
    summary.reviewTurnaroundHoursP75 = null;
    summary.reviewTurnaroundHoursP95 = null;
    evidence.push({
      dimension: "process",
      signalType: "gap",
      stageHint: 1,
      text: "Review turnaround n/a — no reviewed PRs in the deep-dive sample.",
    });
  }

  // Review depth — comments + iteration count averaged across sample.
  if (args.prDetails.length > 0) {
    const avgComments =
      args.prDetails.reduce((a, p) => a + p.commentCount, 0) /
      args.prDetails.length;
    const avgIters =
      args.prDetails.reduce((a, p) => a + p.reviewIterations, 0) /
      args.prDetails.length;
    summary.commentsPerPRAvg = round1(avgComments);
    summary.reviewIterationsAvg = round1(avgIters);
    evidence.push({
      dimension: "process",
      signalType: avgIters >= 1.5 || avgComments >= 3 ? "strength" : "gap",
      stageHint: avgIters >= 2 ? 4 : avgIters >= 1 ? 3 : 2,
      text: `Review depth: avg ${avgComments.toFixed(1)} comments and ${avgIters.toFixed(1)} review iterations per PR (n=${args.prDetails.length}).`,
    });
  } else {
    summary.commentsPerPRAvg = null;
    summary.reviewIterationsAvg = null;
    evidence.push({
      dimension: "process",
      signalType: "gap",
      stageHint: 1,
      text: "Review depth n/a — no PRs in the deep-dive sample.",
    });
  }

  // PR size distribution.
  const sizeDist: PrSizeDistribution =
    args.prDetails.length > 0
      ? bucketPrSizes(args.prDetails.map((p) => ({ linesChanged: p.linesChanged })))
      : emptySizeDistribution();
  summary.prSizeDistribution = sizeDist;
  if (args.prDetails.length > 0) {
    const small = sizeDist.xs + sizeDist.s;
    const huge = sizeDist.xl;
    const smallShare = small / args.prDetails.length;
    evidence.push({
      dimension: "process",
      signalType: smallShare >= 0.5 ? "strength" : "gap",
      stageHint: smallShare >= 0.6 ? 4 : smallShare >= 0.4 ? 3 : 2,
      text: `PR size distribution: ${sizeDist.xs} xs · ${sizeDist.s} s · ${sizeDist.m} m · ${sizeDist.l} l · ${sizeDist.xl} xl (n=${args.prDetails.length}). ${huge > 0 ? `${huge} PRs over 1k LOC reviewed — risk of rubber-stamping.` : ""}`.trim(),
    });
  } else {
    evidence.push({
      dimension: "process",
      signalType: "gap",
      stageHint: 1,
      text: "PR size distribution n/a — no PRs in the deep-dive sample.",
    });
  }

  // Commit frequency — commits/day in the window.
  if (args.totalCommitsInWindow > 0) {
    const perDay = args.totalCommitsInWindow / SC_LOOKBACK_DAYS;
    summary.commitsPerDay = round2(perDay);
    evidence.push({
      dimension: "process",
      signalType: perDay >= 5 ? "strength" : "gap",
      stageHint: perDay >= 20 ? 5 : perDay >= 5 ? 4 : perDay >= 1 ? 3 : 2,
      text: `Commit frequency: ~${perDay.toFixed(2)} commits/day across sampled repos (${SC_LOOKBACK_DAYS}d, n=${args.totalCommitsInWindow}).`,
    });
  } else {
    summary.commitsPerDay = null;
    evidence.push({
      dimension: "process",
      signalType: "gap",
      stageHint: 1,
      text: `Commit frequency n/a — no commits observed in the last ${SC_LOOKBACK_DAYS} days.`,
    });
  }

  // Rework rate.
  const rework = reworkRate(
    args.prDetails.map((p) => ({ commitsAfterFirstReview: p.commitsAfterFirstReview })),
  );
  if (rework !== null) {
    summary.reworkRate = round3(rework);
    evidence.push({
      dimension: "process",
      signalType: rework <= 0.25 ? "strength" : "gap",
      stageHint: rework <= 0.15 ? 4 : rework <= 0.4 ? 3 : 2,
      text: `Rework rate: ${(rework * 100).toFixed(0)}% of sampled PRs received commits after first review (n=${args.prDetails.length}).`,
    });
  } else {
    summary.reworkRate = null;
    evidence.push({
      dimension: "process",
      signalType: "gap",
      stageHint: 1,
      text: "Rework rate n/a — no PRs in the deep-dive sample.",
    });
  }

  // Bus factor — over commits in the window. Surfaced under the
  // "process" dimension (not "people") so the scoring engine treats it
  // alongside the other source-control delivery-process signals; the
  // PRD groups bus factor with knowledge-distribution risk in process.
  const bf = busFactor(args.authorCommitCounts);
  if (bf !== null) {
    summary.busFactor = bf;
    evidence.push({
      dimension: "process",
      signalType: bf >= 3 ? "strength" : "risk",
      stageHint: bf >= 5 ? 5 : bf >= 3 ? 4 : bf >= 2 ? 3 : 1,
      text: `Bus factor: ${bf} author${bf === 1 ? "" : "s"} cover 50% of commits in the last ${SC_LOOKBACK_DAYS} days.`,
    });
  } else {
    summary.busFactor = null;
    evidence.push({
      dimension: "process",
      signalType: "gap",
      stageHint: 1,
      text: `Bus factor n/a — no commits observed in the last ${SC_LOOKBACK_DAYS} days.`,
    });
  }

  // Branch lifespan — first commit → merge for sampled merged PRs.
  const branches = args.prDetails
    .filter((p): p is ScPrDetail & { firstCommitMs: number } => p.firstCommitMs !== null)
    .map((p) => ({ firstCommitMs: p.firstCommitMs, mergedAtMs: p.mergedAtMs }));
  const lifespan = branchLifespanStats(branches);
  if (lifespan.avgHours !== null) {
    summary.branchLifespanHoursAvg = round1(lifespan.avgHours);
    summary.branchLifespanHoursP50 = lifespan.p50Hours ? round1(lifespan.p50Hours) : null;
    summary.branchLifespanHoursP95 = lifespan.p95Hours ? round1(lifespan.p95Hours) : null;
    evidence.push({
      dimension: "process",
      signalType: lifespan.avgHours <= 72 ? "strength" : "gap",
      stageHint: lifespan.avgHours <= 24 ? 5 : lifespan.avgHours <= 72 ? 4 : lifespan.avgHours <= 168 ? 3 : 2,
      text: `Branch lifespan: avg ${lifespan.avgHours.toFixed(1)}h from first commit to merge (n=${lifespan.n}).`,
    });
  } else {
    summary.branchLifespanHoursAvg = null;
    summary.branchLifespanHoursP50 = null;
    summary.branchLifespanHoursP95 = null;
    evidence.push({
      dimension: "process",
      signalType: "gap",
      stageHint: 1,
      text: "Branch lifespan n/a — no PRs with attributable first-commit timestamps in the deep-dive sample.",
    });
  }

  // Sampling provenance — surfaced as evidence for measurement-dimension
  // scoring (the org has, or hasn't, instrumented enough). We expose
  // both the attempted sample size and the count that actually returned
  // valid detail so reviewers can spot a connector that's silently
  // failing per-PR calls (e.g. token missing `repo` scope on a private
  // PR). The provenance text also mentions the per-list page caps so
  // anyone reading evidence understands these are bounded samples.
  const succeeded = args.prDetails.length;
  const attempted = args.prsAttemptedForDetail;
  summary.prsSampledForDetail = succeeded;
  summary.prsAttemptedForDetail = attempted;
  summary.prsAvailableForDetail = args.prsInWindow;
  if (args.prsInWindow > 0) {
    const succeededNote =
      attempted === succeeded
        ? `${succeeded}`
        : `${succeeded} of ${attempted} attempted`;
    evidence.push({
      dimension: "measurement",
      signalType: "quote",
      text: `Source-control metrics sampled ${succeededNote} merged PRs/MRs out of ${args.prsInWindow} observed in the last ${SC_LOOKBACK_DAYS} days. List endpoints are capped at 30 PRs/MRs and 100 commits per repo/project for cost control, so very high-volume orgs are also sampled at the list level.`,
    });
  }

  return { summary, evidence };
}

function round1(n: number): number {
  return Number(n.toFixed(1));
}
function round2(n: number): number {
  return Number(n.toFixed(2));
}
function round3(n: number): number {
  return Number(n.toFixed(3));
}

/**
 * Default sliding lookback window (in days) when an engagement has not
 * customised it. Per-engagement override lives in `engagements.connector_
 * lookback_days` and is clamped to [LOOKBACK_MIN_DAYS, LOOKBACK_MAX_DAYS]
 * by the engagements PATCH route.
 */
export const DEFAULT_CONNECTOR_LOOKBACK_DAYS = 90;
export const LOOKBACK_MIN_DAYS = 7;
export const LOOKBACK_MAX_DAYS = 365;

/**
 * Default wall-clock budget for a single connector run. Replaces the old
 * hardcoded "first 5/10 repos" sample caps — runners now iterate every
 * resource and break only when this budget is exhausted, persisting a
 * resume cursor so the next run picks up where this one stopped.
 */
export const DEFAULT_WALL_CLOCK_BUDGET_MS = 5 * 60_000; // 5 minutes

/**
 * Per-request context passed into connector calls so subcall-level logging
 * can be correlated with the originating API call. Routes pass `req.id`
 * here; the connector emits start/end log lines tagged with that id.
 *
 * `lookbackDays`, `wallClockBudgetMs`, and `priorCursors` are populated by
 * the connector runner from the engagement's setting and the previous run
 * row, respectively. When called from `verifyConnector` they are absent
 * (verify is a one-shot capability check, not a collection).
 */
export type ConnectorCtx = {
  requestId?: string;
  engagementId?: string;
  lookbackDays?: number;
  wallClockBudgetMs?: number;
  priorCursors?: Record<string, unknown>;
  /**
   * Optional incremental-checkpoint callback. Runners call this after each
   * iteration of a long walk so the runner can flush cursors+coverage+
   * recordsCollected to the connector_runs row before the loop continues.
   * If a run is killed/crashed mid-walk, the next run reads back the latest
   * checkpoint and resumes from there instead of restarting the prefix.
   *
   * The implementation in connector-runner debounces these calls (so a
   * tight loop doesn't hammer the DB), so runners can call it freely on
   * every iteration without worrying about cost. Returns void; failures are
   * swallowed by the implementation since checkpointing must never break
   * the run itself.
   */
  checkpoint?: (state: {
    cursors?: Record<string, unknown>;
    coverage?: Record<string, unknown>;
    recordsCollected?: number;
  }) => Promise<void> | void;
};

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
  /**
   * Per-resource opaque resume cursors. The runner persists this on the
   * connector_runs row; the next run reads it back as `ctx.priorCursors`.
   * Shape is connector-specific (e.g. GitHub uses
   * `{ repos: { workflowsIndex, doraIndex, total } }`).
   */
  cursors?: Record<string, unknown>;
  /**
   * Per-resource coverage stats so the run-history UI can surface "sampled
   * 7 of 42 repos this run, 35 remaining" without inferring it from the
   * cursor shape.
   */
  coverage?: Record<string, unknown>;
}

/**
 * Returns true while the wall-clock budget for the current run still has
 * room to start another expensive sub-fetch. Runners check this BEFORE the
 * call so we never abort partway through writing a record.
 */
export function withinBudget(startMs: number, budgetMs: number): boolean {
  return Date.now() - startMs < budgetMs;
}

/** Coerce the `priorCursors[key]` slot into a plain object for safe lookups. */
function readCursor(
  prior: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> {
  const v = prior?.[key];
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function readCursorIndex(
  prior: Record<string, unknown> | undefined,
  resource: string,
  field: string,
): number {
  const c = readCursor(prior, resource);
  const v = c[field];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/**
 * Resolve the lookback window from the per-call ctx with sane fallbacks.
 * Centralised so every runner agrees on the same default and clamping.
 */
function resolveLookbackDays(ctx: ConnectorCtx): number {
  const raw = ctx.lookbackDays ?? DEFAULT_CONNECTOR_LOOKBACK_DAYS;
  if (!Number.isFinite(raw)) return DEFAULT_CONNECTOR_LOOKBACK_DAYS;
  return Math.min(LOOKBACK_MAX_DAYS, Math.max(LOOKBACK_MIN_DAYS, Math.floor(raw)));
}

function resolveBudgetMs(ctx: ConnectorCtx): number {
  const raw = ctx.wallClockBudgetMs ?? DEFAULT_WALL_CLOCK_BUDGET_MS;
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WALL_CLOCK_BUDGET_MS;
}

// ---------------------------------------------------------------------------
// Shared metric helpers
// ---------------------------------------------------------------------------
// Percentile utility used by every CI/CD runner so build-duration, queue-time
// and lead-time series stay numerically consistent across providers. We use
// linear interpolation between the two surrounding samples (the same method
// numpy.percentile uses by default) so a tiny series of 2-3 samples still
// returns a meaningful p75/p95 instead of "always the max".
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (p <= 0) return sorted[0]!;
  if (p >= 1) return sorted[sorted.length - 1]!;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

interface Percentiles {
  p50: number | null;
  p75: number | null;
  p95: number | null;
  count: number;
}

function percentiles(values: number[]): Percentiles {
  if (values.length === 0)
    return { p50: null, p75: null, p95: null, count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p95: percentile(sorted, 0.95),
    count: sorted.length,
  };
}

// Convert a number of milliseconds to a fixed-precision number of seconds or
// minutes for the summary JSON. We keep raw ms in computation and only round
// at emit time so percentile maths aren't lossy.
function msToMinutes(ms: number | null): number | null {
  if (ms === null) return null;
  return Number((ms / 60_000).toFixed(2));
}

function msToHours(ms: number | null): number | null {
  if (ms === null) return null;
  return Number((ms / 3_600_000).toFixed(2));
}

// Walk a sorted-by-time series of run results and pair every "failure" with
// the next "success" on the same target. Returns the duration (ms) between
// each such pair so the caller can average → DORA MTTR.
function deployFailureMttrMs(
  runs: Array<{ ts: number; ok: boolean; target: string }>,
): number[] {
  const byTarget = new Map<string, Array<{ ts: number; ok: boolean }>>();
  for (const r of runs) {
    const arr = byTarget.get(r.target) ?? [];
    arr.push({ ts: r.ts, ok: r.ok });
    byTarget.set(r.target, arr);
  }
  const durations: number[] = [];
  for (const arr of byTarget.values()) {
    arr.sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < arr.length; i++) {
      if (arr[i]!.ok) continue;
      // Find the next successful run on this target after the failure.
      for (let j = i + 1; j < arr.length; j++) {
        if (arr[j]!.ok) {
          durations.push(arr[j]!.ts - arr[i]!.ts);
          break;
        }
      }
    }
  }
  return durations;
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

/**
 * Deep-dive collector for one merged PR. Used by the source-control
 * metric block to compute time-to-first-review, review iterations,
 * comments-per-PR, size bucket, rework rate, and branch lifespan.
 *
 * Returns null on any error so a single 500 / 404 cannot poison the
 * whole metric block. We deliberately do NOT bubble per-PR errors —
 * the surrounding runner already has try/catch boundaries for the
 * coarse metrics, and this is a best-effort enrichment.
 */
async function fetchGithubPrDetail(
  token: string,
  org: string,
  pr: { repo: string; number: number; createdAtMs: number; mergedAtMs: number },
): Promise<ScPrDetail | null> {
  try {
    const base = `https://api.github.com/repos/${org}/${pr.repo}/pulls/${pr.number}`;
    type Detail = {
      additions: number;
      deletions: number;
      comments: number;
      review_comments: number;
    };
    type Review = { state: string; submitted_at: string | null };
    type Commit = { commit: { author: { date: string } } };
    const [detail, reviews, commits] = await Promise.all([
      ghFetch<Detail>(token, base),
      ghFetch<Review[]>(token, `${base}/reviews?per_page=100`),
      ghFetch<Commit[]>(token, `${base}/commits?per_page=100`),
    ]);
    const submittedReviews = reviews
      .filter((r) => r.submitted_at)
      .map((r) => ({ state: r.state, ms: Date.parse(r.submitted_at as string) }))
      .filter((r) => Number.isFinite(r.ms))
      .sort((a, b) => a.ms - b.ms);
    const firstReviewMs = submittedReviews[0]?.ms ?? null;
    const commitTimes = commits
      .map((c) => Date.parse(c.commit.author.date))
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b);
    const firstCommitMs = commitTimes[0] ?? null;
    const commitsAfterFirstReview =
      firstReviewMs === null
        ? 0
        : commitTimes.filter((t) => t > firstReviewMs).length;
    return {
      leadTimeMs: pr.mergedAtMs - pr.createdAtMs,
      timeToFirstReviewMs:
        firstReviewMs !== null ? firstReviewMs - pr.createdAtMs : null,
      reviewTurnaroundMs:
        firstReviewMs !== null ? pr.mergedAtMs - firstReviewMs : null,
      reviewIterations: submittedReviews.length,
      commentCount: (detail.comments ?? 0) + (detail.review_comments ?? 0),
      linesChanged: (detail.additions ?? 0) + (detail.deletions ?? 0),
      commitsAfterFirstReview,
      firstCommitMs,
      mergedAtMs: pr.mergedAtMs,
    };
  } catch {
    return null;
  }
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
  ctx: ConnectorCtx = {},
): Promise<ConnectorRunResult> {
  const org = String(config.org ?? "");
  const evidence: CollectedEvidence[] = [];
  let recordsCollected = 0;
  const summary: Record<string, unknown> = {};
  const startMs = Date.now();
  const lookbackDays = resolveLookbackDays(ctx);
  const budgetMs = resolveBudgetMs(ctx);
  // Two independent walks (workflows + DORA) over the same repo list. We
  // resume each from its own index so the run before us can have completed
  // workflows fully but stopped mid-DORA — re-running picks up correctly.
  const cursorWorkflowsStart = readCursorIndex(ctx.priorCursors, "repos", "workflowsIndex");
  const cursorDoraStart = readCursorIndex(ctx.priorCursors, "repos", "doraIndex");

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
  // Paginate the org's repository list. Replaces the old single-page
  // `per_page=30` call which silently capped discovery to the 30 most
  // recently pushed repos. We walk every page until empty, breaking only
  // on the wall-clock budget. For very large orgs (>1000 repos) this
  // can dominate the budget; that's acceptable because next run resumes
  // from page 1 (cheap) and the cursor below points into whatever list
  // we managed to discover.
  const REPOS_PAGE_SIZE = 100;
  const repos: Array<{ name: string; default_branch: string; pushed_at: string }> = [];
  let reposPage = 1;
  let reposDiscoveryComplete = false;
  while (withinBudget(startMs, budgetMs)) {
    const batch = await ghFetch<
      Array<{ name: string; default_branch: string; pushed_at: string }>
    >(
      token,
      `https://api.github.com/orgs/${org}/repos?per_page=${REPOS_PAGE_SIZE}&sort=pushed&page=${reposPage}`,
    );
    if (batch.length === 0) {
      reposDiscoveryComplete = true;
      break;
    }
    repos.push(...batch);
    if (batch.length < REPOS_PAGE_SIZE) {
      reposDiscoveryComplete = true;
      break;
    }
    reposPage += 1;
  }
  recordsCollected += repos.length;
  summary.repoCount = repos.length;
  summary.reposDiscoveryComplete = reposDiscoveryComplete;

  // Look for AI-related workflows. Iterate every repo (not the old top-10
  // slice) but break when wall-clock budget is exhausted, persisting the
  // resume index so the next run continues from there.
  let aiWorkflowRepos = 0;
  let totalWorkflowRepos = 0;
  let workflowsSampled = 0;
  let nextWorkflowsIndex = cursorWorkflowsStart;
  if (repos.length > 0 && cursorWorkflowsStart >= repos.length) {
    // Cursor wraps once we've walked the whole list — start fresh.
    nextWorkflowsIndex = 0;
  }
  for (let i = nextWorkflowsIndex; i < repos.length; i += 1) {
    if (!withinBudget(startMs, budgetMs)) {
      nextWorkflowsIndex = i;
      break;
    }
    const r = repos[i]!;
    try {
      const wf = await ghFetch<{ workflows: Array<{ name: string; path: string }> }>(
        token,
        `https://api.github.com/repos/${org}/${r.name}/actions/workflows`,
      );
      if (wf.workflows.length > 0) totalWorkflowRepos += 1;
      if (
        wf.workflows.some((w) =>
          /\b(copilot|cursor|claude|openai|llm|ai|cody|codeium|windsurf|amazon[-_ ]q|amazonq)\b/i.test(`${w.name} ${w.path}`),
        )
      ) {
        aiWorkflowRepos += 1;
      }
      recordsCollected += wf.workflows.length;
    } catch {
      // skip repos we can't access
    }
    workflowsSampled += 1;
    nextWorkflowsIndex = i + 1;
    // Incremental checkpoint so a kill/crash mid-walk still leaves the
    // resume cursor up-to-date in the connector_runs row. Debounced by
    // the runner so we can call it freely on every iteration.
    await ctx.checkpoint?.({
      cursors: {
        repos: {
          workflowsIndex: nextWorkflowsIndex,
          doraIndex: cursorDoraStart,
          total: repos.length,
        },
      },
      coverage: {
        repos: {
          total: repos.length,
          workflowsSampled,
          doraSampled: 0,
          workflowsRemaining: Math.max(0, repos.length - workflowsSampled),
          doraRemaining: repos.length,
        },
      },
      recordsCollected,
    });
  }
  // Wrap when we cleanly walked the entire list this run.
  if (nextWorkflowsIndex >= repos.length) nextWorkflowsIndex = 0;
  summary.aiWorkflowRepos = aiWorkflowRepos;
  summary.workflowRepos = totalWorkflowRepos;

  if (aiWorkflowRepos > 0) {
    evidence.push({
      dimension: "tooling",
      signalType: "strength",
      stageHint: aiWorkflowRepos >= 3 ? 4 : 3,
      text: `Detected AI-related GitHub Actions workflows in ${aiWorkflowRepos} of ${workflowsSampled} sampled repos.`,
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
  // Each metric gets its own evidence row tagged to the right dimension so
  // the scoring engine can pick them up consistently across providers. The
  // lookback window comes from the engagement's connectorLookbackDays so
  // the same code serves a 7-day spot-check and a 365-day backfill.
  const sinceMs = Date.now() - lookbackDays * 86_400_000;
  const since = new Date(sinceMs).toISOString();
  let workflowRunsTotal = 0;
  let workflowRunsFailed = 0;
  let workflowRunsSucceeded = 0;
  let prsSampled = 0;
  let prsMerged = 0;
  let prLeadTimeSumMs = 0;
  let prLeadTimeCount = 0;
  const prLeadTimesMs: number[] = [];
  let prsWithReviews = 0;
  // CI/CD build-quality series. Build duration uses `updated_at` (final
  // status timestamp) − `run_started_at`; queue time uses `run_started_at`
  // − `created_at`. Flaky retries are runs where `run_attempt > 1`
  // ultimately succeeded — i.e. an earlier attempt on the same SHA failed
  // and a rerun passed. Deploy-failure MTTR pairs each failed run with the
  // next successful run on the same workflow+branch.
  const buildDurationsMs: number[] = [];
  const queueTimesMs: number[] = [];
  let runsWithRetries = 0;
  let flakyRetrySuccesses = 0;
  const deployRunSeries: Array<{ ts: number; ok: boolean; target: string }> = [];
  // Job-level series — populated by a follow-up `/actions/runs/{id}/jobs`
  // call per sampled run. Job duration is the wall time the runner spent on
  // that single job; queue time is `started_at − run.created_at`. Flaky
  // detection groups by `(job_name, head_sha)`: if any attempt failed and a
  // later attempt of the same job+SHA succeeded, that group counts as a
  // flaky-pass-on-retry. The denominator is total `(job_name, head_sha)`
  // groups observed across sampled runs. We cap to 15 runs per repo
  // (GH_JOB_RUNS_PER_REPO) to keep the API budget bounded — at 5 repos
  // that's <=75 extra calls vs. 5 baseline workflow_runs calls.
  const GH_JOB_RUNS_PER_REPO = 15;
  const jobDurationsMs: number[] = [];
  const jobQueueTimesMs: number[] = [];
  type GhJobAttempt = { conclusion: string | null; runAttempt: number };
  const jobGroups = new Map<string, GhJobAttempt[]>();
  let jobRunsSampled = 0;
  let jobsObserved = 0;
  let jobSampleTruncated = false;
  // Cursor-driven DORA walk so a budget-truncated run resumes from the
  // next un-walked repo instead of restarting at index 0.
  let doraSampled = 0;
  let nextDoraIndex = cursorDoraStart;
  if (repos.length > 0 && cursorDoraStart >= repos.length) nextDoraIndex = 0;

  // Source-control metric inputs collected across the walked repos.
  // Kept separate from the DORA block so the existing summary keys
  // (deploysPerDay, changeFailureRate, leadTimeHoursAvg, prReviewRate)
  // remain backwards-compatible while the new percentile-based block is
  // populated alongside them.
  const allLeadTimesMs: number[] = [];
  const mergedPrCandidates: Array<{
    repo: string;
    number: number;
    createdAtMs: number;
    mergedAtMs: number;
  }> = [];
  const authorCommitCounts: Record<string, number> = {};
  let totalCommitsInWindow = 0;

  for (let i = nextDoraIndex; i < repos.length; i += 1) {
    if (!withinBudget(startMs, budgetMs)) {
      nextDoraIndex = i;
      break;
    }
    const r = repos[i]!;
    try {
      // Workflow runs in the lookback window → deployment frequency proxy +
      // change-failure-rate proxy. We use `created` as an upper bound on
      // both so the same call serves both metrics.
      const wfr = await ghFetch<{
        total_count: number;
        workflow_runs: Array<{
          id: number;
          conclusion: string | null;
          status: string;
          created_at: string;
          updated_at: string;
          run_started_at: string | null;
          run_attempt: number;
          head_sha: string;
          head_branch: string | null;
          name: string;
        }>;
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
      for (const w of wfr.workflow_runs) {
        // Build duration — only for completed runs where we have both
        // start and end timestamps. `run_started_at` is when the runner
        // actually picked the job up; `updated_at` is when its conclusion
        // was set.
        if (
          w.run_started_at &&
          (w.conclusion === "success" || w.conclusion === "failure")
        ) {
          const dur =
            new Date(w.updated_at).getTime() -
            new Date(w.run_started_at).getTime();
          if (dur > 0) buildDurationsMs.push(dur);
        }
        // Queue time — gap between the workflow being created (queued)
        // and the runner starting it.
        if (w.run_started_at) {
          const q =
            new Date(w.run_started_at).getTime() -
            new Date(w.created_at).getTime();
          if (q >= 0) queueTimesMs.push(q);
        }
        // Flaky-test rate — count how many runs needed a rerun, and how
        // many of those eventually succeeded on the retry.
        if (w.run_attempt > 1) {
          runsWithRetries += 1;
          if (w.conclusion === "success") flakyRetrySuccesses += 1;
        }
        // Deploy-failure MTTR series. We use `<repo>:<workflow>:<branch>`
        // as the deployment target heuristic per the PRD note that
        // there's no explicit environment model yet.
        if (
          (w.conclusion === "success" || w.conclusion === "failure") &&
          w.head_branch
        ) {
          deployRunSeries.push({
            ts: new Date(w.updated_at).getTime(),
            ok: w.conclusion === "success",
            target: `${r.name}:${w.name}:${w.head_branch}`,
          });
        }
      }
      recordsCollected += wfr.workflow_runs.length;
      // Job-level pull for the first N runs in this repo. We fetch with
      // `filter=all` so we get every attempt of every job (otherwise the
      // API returns only the latest attempt's jobs).
      const sampleRuns = wfr.workflow_runs.slice(0, GH_JOB_RUNS_PER_REPO);
      if (wfr.workflow_runs.length > GH_JOB_RUNS_PER_REPO) {
        jobSampleTruncated = true;
      }
      for (const w of sampleRuns) {
        try {
          const jr = await ghFetch<{
            jobs: Array<{
              id: number;
              run_id: number;
              run_attempt: number;
              name: string;
              conclusion: string | null;
              status: string;
              started_at: string | null;
              completed_at: string | null;
              head_sha?: string;
            }>;
          }>(
            token,
            `https://api.github.com/repos/${org}/${r.name}/actions/runs/${w.id}/jobs?filter=all&per_page=100`,
          );
          jobRunsSampled += 1;
          for (const j of jr.jobs) {
            jobsObserved += 1;
            if (
              j.started_at &&
              j.completed_at &&
              (j.conclusion === "success" || j.conclusion === "failure")
            ) {
              const dur =
                new Date(j.completed_at).getTime() -
                new Date(j.started_at).getTime();
              if (dur > 0) jobDurationsMs.push(dur);
              const q =
                new Date(j.started_at).getTime() -
                new Date(w.created_at).getTime();
              if (q >= 0) jobQueueTimesMs.push(q);
            }
            const groupKey = `${r.name}::${j.name}::${w.head_sha}`;
            const existing = jobGroups.get(groupKey) ?? [];
            existing.push({
              conclusion: j.conclusion,
              runAttempt: j.run_attempt,
            });
            jobGroups.set(groupKey, existing);
          }
        } catch {
          // ignore — jobs API may be unavailable for this run
        }
      }
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
          const mergedMs = new Date(p.merged_at).getTime();
          // Bound merged PRs to the lookback window — `state=closed` gives
          // us older PRs too, which would inflate throughput counts and
          // skew percentiles.
          if (mergedMs >= sinceMs) {
            prsMerged += 1;
            const createdMs = new Date(p.created_at).getTime();
            const lead = mergedMs - createdMs;
            if (lead > 0) {
              prLeadTimeSumMs += lead;
              prLeadTimeCount += 1;
              prLeadTimesMs.push(lead);
              allLeadTimesMs.push(lead);
              mergedPrCandidates.push({
                repo: r.name,
                number: p.number,
                createdAtMs: createdMs,
                mergedAtMs: mergedMs,
              });
            }
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

    // Repo-level commits in the window — feeds commit frequency + bus
    // factor. One page (100) per repo keeps cost flat; if a repo has more
    // we capture the most recent 100 which is a reasonable activity
    // sample for the lookback window. Author identity falls back to
    // commit.author.email when GitHub couldn't link the commit to a user.
    try {
      const commits = await ghFetch<
        Array<{
          sha: string;
          commit: { author: { date: string; name?: string; email?: string } };
          author: { login: string } | null;
        }>
      >(
        token,
        `https://api.github.com/repos/${org}/${r.name}/commits?per_page=100&since=${since}`,
      );
      for (const c of commits) {
        totalCommitsInWindow += 1;
        const id =
          c.author?.login ??
          c.commit.author?.email ??
          c.commit.author?.name ??
          "unknown";
        authorCommitCounts[id] = (authorCommitCounts[id] ?? 0) + 1;
      }
      recordsCollected += commits.length;
    } catch {
      // ignore — empty/disabled repo
    }
    doraSampled += 1;
    nextDoraIndex = i + 1;
    await ctx.checkpoint?.({
      cursors: {
        repos: {
          workflowsIndex: nextWorkflowsIndex,
          doraIndex: nextDoraIndex,
          total: repos.length,
        },
      },
      coverage: {
        repos: {
          total: repos.length,
          workflowsSampled,
          doraSampled,
          workflowsRemaining: Math.max(0, repos.length - workflowsSampled),
          doraRemaining: Math.max(0, repos.length - doraSampled),
        },
      },
      recordsCollected,
    });
  }
  if (nextDoraIndex >= repos.length) nextDoraIndex = 0;

  // ---- Source-control deep-dive sample (PR detail / reviews / commits)
  // Each sampled PR costs 3 extra REST calls; cap by detailSampleSize +
  // SC_DETAIL_HARD_CAP so a 1000-PR/month repo doesn't explode our run
  // budget. Errors on individual PRs are skipped so a single 500 doesn't
  // poison the whole metric block.
  const sampleN = Math.min(
    detailSampleSize(mergedPrCandidates.length, SC_LOOKBACK_DAYS),
    SC_DETAIL_HARD_CAP,
  );
  const sampledPrs = mergedPrCandidates.slice(0, sampleN);
  const prDetails: ScPrDetail[] = [];
  for (const p of sampledPrs) {
    const detail = await fetchGithubPrDetail(token, org, p);
    if (detail) prDetails.push(detail);
  }
  recordsCollected += prDetails.length;

  const sc = buildSourceControlSummary({
    prDetails,
    allLeadTimesMs,
    authorCommitCounts,
    totalCommitsInWindow,
    prsInWindow: mergedPrCandidates.length,
    prsAttemptedForDetail: sampledPrs.length,
  });
  Object.assign(summary, sc.summary);
  evidence.push(...sc.evidence);

  // Deployment frequency (successful workflow runs / day, lookback window) —
  // proxy for DORA "deployment frequency". Only successful runs count as
  // deployments; failed runs feed change-failure-rate instead so the two
  // metrics stay independent. Per-day rate uses lookbackDays as denominator
  // so a 7-day or 365-day window are both expressed as deploys/day.
  const deploysPerDay = workflowRunsSucceeded / lookbackDays;
  summary.workflowRunsTotal = workflowRunsTotal;
  summary.workflowRunsSucceeded = workflowRunsSucceeded;
  summary.workflowRunsFailed = workflowRunsFailed;
  summary.deploysPerDay = Number(deploysPerDay.toFixed(2));
  if (workflowRunsSucceeded > 0) {
    evidence.push({
      dimension: "process",
      signalType: deploysPerDay >= 1 ? "strength" : "gap",
      stageHint: deploysPerDay >= 5 ? 5 : deploysPerDay >= 1 ? 4 : 2,
      text: `Deployment frequency: ~${deploysPerDay.toFixed(2)} successful CI runs/day across sampled repos (${lookbackDays}d).`,
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
      text: `Change failure rate proxy: ${(cfr * 100).toFixed(1)}% (${workflowRunsFailed}/${workflowRunsTotal} CI runs failed, ${lookbackDays}d).`,
    });
  }

  // Lead time for changes — average + p50/p75/p95 of PR created→merged
  // across the sample. Percentiles are added so an outlier-heavy
  // distribution doesn't get summarized to a misleadingly low average
  // alone.
  if (prLeadTimeCount > 0) {
    const avgHours = prLeadTimeSumMs / prLeadTimeCount / 3_600_000;
    summary.leadTimeHoursAvg = Number(avgHours.toFixed(1));
    const lt = percentiles(prLeadTimesMs);
    summary.leadTimeHoursP50 = msToHours(lt.p50);
    summary.leadTimeHoursP75 = msToHours(lt.p75);
    summary.leadTimeHoursP95 = msToHours(lt.p95);
    evidence.push({
      dimension: "process",
      signalType: avgHours <= 48 ? "strength" : "gap",
      stageHint: avgHours <= 24 ? 5 : avgHours <= 48 ? 4 : avgHours <= 168 ? 3 : 2,
      text: `Lead time for changes: avg ${avgHours.toFixed(1)}h, p50 ${msToHours(lt.p50)?.toFixed(1)}h / p75 ${msToHours(lt.p75)?.toFixed(1)}h / p95 ${msToHours(lt.p95)?.toFixed(1)}h from PR open to merge (n=${prLeadTimeCount}).`,
    });
  }

  // ---- CI/CD build quality ---------------------------------------------
  // Build duration & queue time prefer job-level data (PRD-aligned: jobs,
  // not workflow runs) when available; fall back to workflow-run level if
  // the jobs API was unreachable for every sampled run. Build success rate
  // stays workflow-run level because GitHub's "run conclusion" is the
  // authoritative top-line outcome. Flaky-test rate uses job-level grouping
  // by `(repo, job_name, head_sha)` per the PRD definition ("jobs that pass
  // on retry of same SHA"), with the workflow-run signal kept as a fallback.
  const useJobLevelDuration = jobDurationsMs.length > 0;
  const bd = percentiles(useJobLevelDuration ? jobDurationsMs : buildDurationsMs);
  const buildUnit = useJobLevelDuration ? "jobs" : "workflow_runs";
  if (bd.count > 0) {
    summary.buildDurationMinutesP50 = msToMinutes(bd.p50);
    summary.buildDurationMinutesP75 = msToMinutes(bd.p75);
    summary.buildDurationMinutesP95 = msToMinutes(bd.p95);
    summary.buildDurationSampleSize = bd.count;
    summary.buildDurationUnit = buildUnit;
    const p95min = msToMinutes(bd.p95) ?? 0;
    evidence.push({
      dimension: "measurement",
      signalType: p95min <= 15 ? "strength" : "gap",
      stageHint: p95min <= 10 ? 5 : p95min <= 15 ? 4 : p95min <= 30 ? 3 : 2,
      text: `CI build duration: p50 ${msToMinutes(bd.p50)?.toFixed(1)}m / p75 ${msToMinutes(bd.p75)?.toFixed(1)}m / p95 ${p95min.toFixed(1)}m (n=${bd.count} ${buildUnit}, 30d).`,
    });
  }
  const useJobLevelQueue = jobQueueTimesMs.length > 0;
  const qt = percentiles(useJobLevelQueue ? jobQueueTimesMs : queueTimesMs);
  const queueUnit = useJobLevelQueue ? "jobs" : "workflow_runs";
  if (qt.count > 0) {
    summary.queueTimeMinutesP50 = msToMinutes(qt.p50);
    summary.queueTimeMinutesP75 = msToMinutes(qt.p75);
    summary.queueTimeSampleSize = qt.count;
    summary.queueTimeUnit = queueUnit;
    const p75min = msToMinutes(qt.p75) ?? 0;
    evidence.push({
      dimension: "measurement",
      signalType: p75min <= 1 ? "strength" : "gap",
      stageHint: p75min <= 1 ? 5 : p75min <= 5 ? 4 : p75min <= 15 ? 3 : 2,
      text: `CI queue time: p50 ${msToMinutes(qt.p50)?.toFixed(2)}m / p75 ${p75min.toFixed(2)}m before runner pickup (n=${qt.count} ${queueUnit}, 30d).`,
    });
  }
  if (jobsObserved > 0) {
    summary.jobsObserved30d = jobsObserved;
    summary.jobRunsSampled30d = jobRunsSampled;
    if (jobSampleTruncated) {
      summary.jobSampleTruncated = true;
      summary.jobSampleTruncatedReason = `Only the first ${GH_JOB_RUNS_PER_REPO} workflow runs per repo were inspected for jobs to bound API cost; flaky/build/queue percentiles reflect that sample.`;
    }
  }
  // Build success rate is the inverse of change-failure-rate but is the
  // PRD-prescribed name; we expose both so dashboards can pick whichever
  // they prefer without recomputation.
  if (workflowRunsTotal > 0) {
    const successRate = workflowRunsSucceeded / workflowRunsTotal;
    summary.buildSuccessRate = Number(successRate.toFixed(3));
    // Emit explicit build-success-rate evidence in addition to the
    // change-failure-rate row so scoring rubrics that key off
    // "buildSuccessRate" have a first-class signal to attach to.
    evidence.push({
      dimension: "measurement",
      signalType: successRate >= 0.9 ? "strength" : "gap",
      stageHint:
        successRate >= 0.95 ? 5 : successRate >= 0.9 ? 4 : successRate >= 0.75 ? 3 : 2,
      text: `Build success rate: ${(successRate * 100).toFixed(1)}% of CI runs succeeded (${workflowRunsSucceeded}/${workflowRunsTotal}, 30d).`,
    });
  }
  // Flaky-test rate prefers job-level grouping per the PRD
  // ("jobs that pass on retry of same SHA"). For each
  // (repo, job_name, head_sha) group with at least one earlier failed
  // attempt and a later successful attempt, count it as a flaky pass.
  // The denominator is the total number of distinct (job_name, head_sha)
  // groups observed in the sampled runs. If the jobs API returned nothing
  // we fall back to the workflow-run signal (`run_attempt > 1`
  // succeeded / total runs) so the metric is still populated.
  if (jobGroups.size > 0) {
    let jobFlakyRetrySuccesses = 0;
    for (const attempts of jobGroups.values()) {
      if (attempts.length < 2) continue;
      const sorted = [...attempts].sort(
        (a, b) => a.runAttempt - b.runAttempt,
      );
      const earlierFailed = sorted
        .slice(0, -1)
        .some((a) => a.conclusion === "failure");
      const finalOk = sorted[sorted.length - 1]?.conclusion === "success";
      if (earlierFailed && finalOk) jobFlakyRetrySuccesses += 1;
    }
    const denom = jobGroups.size;
    const flakyRate = jobFlakyRetrySuccesses / denom;
    summary.flakyTestRate = Number(flakyRate.toFixed(3));
    summary.flakyRetrySuccesses30d = jobFlakyRetrySuccesses;
    summary.flakyDenominator30d = denom;
    summary.flakyDenominatorUnit = "jobs";
    summary.runsWithRetries30d = runsWithRetries;
    evidence.push({
      dimension: "measurement",
      signalType: flakyRate <= 0.02 ? "strength" : "gap",
      stageHint: flakyRate <= 0.01 ? 5 : flakyRate <= 0.05 ? 3 : 2,
      text:
        jobFlakyRetrySuccesses === 0
          ? `Flaky CI rate: 0% — no jobs needed a passing retry on the same SHA across ${denom} sampled (job, SHA) groups (30d).`
          : `Flaky CI rate: ${(flakyRate * 100).toFixed(1)}% of (job, SHA) groups passed on retry (${jobFlakyRetrySuccesses}/${denom}, 30d).`,
    });
  } else if (workflowRunsTotal > 0) {
    const flakyRate = flakyRetrySuccesses / workflowRunsTotal;
    summary.flakyTestRate = Number(flakyRate.toFixed(3));
    summary.flakyRetrySuccesses30d = flakyRetrySuccesses;
    summary.flakyDenominator30d = workflowRunsTotal;
    summary.flakyDenominatorUnit = "workflow_runs";
    summary.runsWithRetries30d = runsWithRetries;
    // Emit a flaky evidence row whenever we have a denominator, even at
    // 0% — a strong "no flakes observed" outcome should be visible to
    // the assessor, not silently absent.
    evidence.push({
      dimension: "measurement",
      signalType: flakyRate <= 0.02 ? "strength" : "gap",
      stageHint: flakyRate <= 0.01 ? 5 : flakyRate <= 0.05 ? 3 : 2,
      text:
        flakyRetrySuccesses === 0
          ? `Flaky CI rate: 0% — no workflow runs needed a passing retry on the same SHA in the last 30 days (n=${workflowRunsTotal}).`
          : `Flaky CI rate: ${(flakyRate * 100).toFixed(1)}% of workflow runs passed on retry of the same SHA (${flakyRetrySuccesses}/${workflowRunsTotal}, 30d).`,
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

  // ---- MTTR -----------------------------------------------------------
  // Per the PRD, the canonical DORA MTTR is "deployment failure → next
  // successful deploy on the same target". We compute that first from the
  // workflow-run stream (workflow + branch as the target heuristic). When
  // no failure→success pair exists in the window we fall back to the
  // incident-issue proxy and tag the provenance so the assessor can tell
  // which signal drove the score.
  const deployMttrSeries = deployFailureMttrMs(deployRunSeries);
  if (deployMttrSeries.length > 0) {
    const avgMs =
      deployMttrSeries.reduce((s, x) => s + x, 0) / deployMttrSeries.length;
    const mttrHours = avgMs / 3_600_000;
    const dp = percentiles(deployMttrSeries);
    summary.mttrHoursAvg = Number(mttrHours.toFixed(1));
    summary.mttrHoursP50 = msToHours(dp.p50);
    summary.mttrHoursP95 = msToHours(dp.p95);
    summary.mttrSource = "deployment_failure";
    summary.deployFailurePairsInWindow = deployMttrSeries.length;
    evidence.push({
      dimension: "measurement",
      signalType: mttrHours <= 24 ? "strength" : "gap",
      stageHint: mttrHours <= 4 ? 5 : mttrHours <= 24 ? 4 : mttrHours <= 72 ? 3 : 2,
      text: `MTTR (deploy failure → next success): avg ${mttrHours.toFixed(1)}h, p50 ${msToHours(dp.p50)?.toFixed(1)}h / p95 ${msToHours(dp.p95)?.toFixed(1)}h across ${deployMttrSeries.length} pairs (${lookbackDays}d).`,
    });
  }

  // Incident-labeled issues closed in the lookback window. Used as the MTTR
  // signal when no deploy failure→success pairs exist; otherwise it's
  // recorded but not used as the canonical MTTR.
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
  summary.incidentIssuesInWindow = mttrCount;
  if (deployMttrSeries.length === 0) {
    // No deployment-failure pairs in the window — fall back to the
    // incident-issue proxy so MTTR isn't silently null whenever a window
    // has only successful deploys.
    if (mttrCount > 0) {
      const mttrHours = mttrSumMs / mttrCount / 3_600_000;
      summary.mttrHoursAvg = Number(mttrHours.toFixed(1));
      summary.mttrSource = "incident_issue_fallback";
      evidence.push({
        dimension: "measurement",
        signalType: mttrHours <= 24 ? "strength" : "gap",
        stageHint: mttrHours <= 4 ? 5 : mttrHours <= 24 ? 4 : mttrHours <= 72 ? 3 : 2,
        text: `MTTR (incident-issue fallback): avg ${mttrHours.toFixed(1)}h to close incident-labeled issues (n=${mttrCount}, ${lookbackDays}d). No deploy failure→success pairs available, so this is a proxy.`,
      });
    } else {
      summary.mttrHoursAvg = null;
      summary.mttrSource = "unavailable";
      evidence.push({
        dimension: "measurement",
        signalType: "gap",
        stageHint: 1,
        text: `MTTR n/a — no deploy failure→success pairs and no incident-labeled issues found in the last ${lookbackDays} days. Tag incidents with 'incident', 'outage', 'p0', or 'p1', or ensure failed CI runs are followed by successful reruns to enable MTTR measurement.`,
      });
    }
  } else if (mttrCount > 0) {
    // Keep the incident-issue average alongside the canonical MTTR for
    // comparison without overwriting it.
    summary.incidentIssueMttrHoursAvg = Number(
      (mttrSumMs / mttrCount / 3_600_000).toFixed(1),
    );
  }

  // Coverage + cursors. The runner persists these so the next run resumes
  // from `nextWorkflowsIndex` / `nextDoraIndex` instead of re-walking the
  // same prefix when the wall-clock budget gets exhausted.
  const coverage = {
    repos: {
      total: repos.length,
      workflowsSampled,
      doraSampled,
      workflowsRemaining: Math.max(0, repos.length - workflowsSampled),
      doraRemaining: Math.max(0, repos.length - doraSampled),
    },
  };
  const cursors = {
    repos: {
      workflowsIndex: nextWorkflowsIndex,
      doraIndex: nextDoraIndex,
      total: repos.length,
    },
  };

  return { recordsCollected, summary, evidence, cursors, coverage };
}

/**
 * Deep-dive collector for one merged MR. Fetches notes (review activity
 * + comments), commits (rework + branch lifespan + iteration count),
 * and diffs (size bucket). Returns null on any sub-error so a single
 * 500 can't poison the metric block.
 *
 * Reviewer / "first review" definition for GitLab: the earliest
 * non-system, non-author note. GitLab's free-tier API does not expose
 * formal "review submitted" events the way GitHub does, but every team
 * we've seen uses `notes` to communicate review feedback, so the
 * earliest such note approximates the same intent.
 */
async function fetchGitlabMrDetail(
  token: string,
  baseUrl: string,
  mr: {
    projectId: number;
    iid: number;
    authorId: number | null;
    createdAtMs: number;
    mergedAtMs: number;
  },
): Promise<ScPrDetail | null> {
  try {
    const headers = { "PRIVATE-TOKEN": token };
    const base = `${baseUrl}/api/v4/projects/${mr.projectId}/merge_requests/${mr.iid}`;
    const [notesRes, commitsRes, changesRes] = await Promise.all([
      fetch(`${base}/notes?per_page=100&sort=asc`, { headers }),
      fetch(`${base}/commits?per_page=100`, { headers }),
      fetch(`${base}/changes`, { headers }),
    ]);
    if (!notesRes.ok || !commitsRes.ok || !changesRes.ok) return null;

    type Note = {
      system: boolean;
      author: { id: number };
      body: string;
      created_at: string;
    };
    type Commit = {
      created_at?: string;
      authored_date?: string;
      committed_date?: string;
      author_email?: string;
      author_name?: string;
    };
    type Changes = {
      changes?: Array<{ diff?: string }>;
    };
    const notes = (await notesRes.json()) as Note[];
    const commits = (await commitsRes.json()) as Commit[];
    const changes = (await changesRes.json()) as Changes;

    // First "review" = earliest non-system, non-author user note.
    const reviewerNotes = notes
      .filter(
        (n) =>
          !n.system &&
          (mr.authorId === null || n.author.id !== mr.authorId) &&
          typeof n.created_at === "string",
      )
      .map((n) => ({
        ms: Date.parse(n.created_at),
        authorId: n.author.id,
      }))
      .filter((n) => Number.isFinite(n.ms))
      .sort((a, b) => a.ms - b.ms);
    const firstReviewMs = reviewerNotes[0]?.ms ?? null;
    // Iteration count — collapse runs of consecutive notes from the
    // same author into one "review submission". This matches GitHub's
    // `reviewIterations` (one number per submitted review) more closely
    // than counting distinct reviewers, so the metric is comparable
    // across providers.
    let reviewIterations = 0;
    let lastAuthor: number | null = null;
    for (const n of reviewerNotes) {
      if (n.authorId !== lastAuthor) {
        reviewIterations += 1;
        lastAuthor = n.authorId;
      }
    }
    // Comment count = all reviewer notes (system events excluded).
    const commentCount = reviewerNotes.length;

    const commitTimes = commits
      .map((c) =>
        Date.parse(c.authored_date ?? c.committed_date ?? c.created_at ?? ""),
      )
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b);
    const firstCommitMs = commitTimes[0] ?? null;
    const commitsAfterFirstReview =
      firstReviewMs === null
        ? 0
        : commitTimes.filter((t) => t > firstReviewMs).length;

    // Lines changed — count `+`/`-` lines in each diff, skipping the
    // `+++`/`---` file headers. We cap per-diff string length at 200 KB
    // so a pathological mega-diff can't OOM the runner.
    let linesChanged = 0;
    for (const ch of changes.changes ?? []) {
      const diff = (ch.diff ?? "").slice(0, 200_000);
      for (const line of diff.split("\n")) {
        if (line.startsWith("+++") || line.startsWith("---")) continue;
        if (line.startsWith("+") || line.startsWith("-")) linesChanged += 1;
      }
    }

    return {
      leadTimeMs: mr.mergedAtMs - mr.createdAtMs,
      timeToFirstReviewMs:
        firstReviewMs !== null ? firstReviewMs - mr.createdAtMs : null,
      reviewTurnaroundMs:
        firstReviewMs !== null ? mr.mergedAtMs - firstReviewMs : null,
      reviewIterations,
      commentCount,
      linesChanged,
      commitsAfterFirstReview,
      firstCommitMs,
      mergedAtMs: mr.mergedAtMs,
    };
  } catch {
    return null;
  }
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
  ctx: ConnectorCtx = {},
): Promise<ConnectorRunResult> {
  const baseUrl = String(config.baseUrl ?? "https://gitlab.com").replace(/\/$/, "");
  await assertSafeUrl(baseUrl);
  const group = String(config.group ?? "");
  const evidence: CollectedEvidence[] = [];
  const startMs = Date.now();
  const lookbackDays = resolveLookbackDays(ctx);
  const budgetMs = resolveBudgetMs(ctx);
  const cursorStart = readCursorIndex(ctx.priorCursors, "projects", "index");
  if (!group)
    return { recordsCollected: 0, summary: { error: "No group configured" }, evidence };
  const headers = { "PRIVATE-TOKEN": token };
  // Paginate the group's project list. Replaces the old single-page
  // `per_page=30` call which silently capped discovery to the first 30
  // projects. We walk every page until empty, breaking only on the
  // wall-clock budget.
  const PROJECTS_PAGE_SIZE = 100;
  const projects: Array<{ name: string; id: number }> = [];
  let projectsPage = 1;
  let projectsDiscoveryComplete = false;
  while (withinBudget(startMs, budgetMs)) {
    const pr = await fetch(
      `${baseUrl}/api/v4/groups/${encodeURIComponent(group)}/projects?per_page=${PROJECTS_PAGE_SIZE}&page=${projectsPage}`,
      { headers },
    );
    if (!pr.ok) throw new Error(`GitLab ${pr.status}`);
    const batch = (await pr.json()) as Array<{ name: string; id: number }>;
    if (batch.length === 0) {
      projectsDiscoveryComplete = true;
      break;
    }
    projects.push(...batch);
    if (batch.length < PROJECTS_PAGE_SIZE) {
      projectsDiscoveryComplete = true;
      break;
    }
    projectsPage += 1;
  }
  evidence.push({
    dimension: "tooling",
    signalType: "strength",
    stageHint: 3,
    text: `Discovered ${projects.length} GitLab projects in group ${group}.`,
  });

  // ---- DORA-style normalized signals (lookback window, budgeted walk) ---
  // sinceMsGl is the same instant as `since` but kept as a number so the
  // SC deep-dive code below can do cheap numeric comparisons against
  // GitLab's merged_at timestamps without re-parsing the ISO string.
  const sinceMsGl = Date.now() - lookbackDays * 86_400_000;
  const since = new Date(sinceMsGl).toISOString();
  let pipelinesTotal = 0;
  let pipelinesFailed = 0;
  let pipelinesSucceeded = 0;
  let mrsMerged = 0;
  let mrLeadSumMs = 0;
  let mrLeadCount = 0;
  const mrLeadTimesMs: number[] = [];
  let mttrSumMs = 0;
  let mttrCount = 0;
  let recordsCollected = projects.length;
  // CI/CD build-quality series across the GitLab project sample. We pull a
  // pipeline-detail call per pipeline because the list endpoint doesn't
  // return `duration` or `queued_duration`. Flaky comes from the
  // per-pipeline jobs endpoint (`retried: true` + final status `success`).
  const buildDurationsMs: number[] = [];
  const queueTimesMs: number[] = [];
  let runsWithRetries = 0;
  let flakyRetrySuccesses = 0;
  let totalJobsObserved = 0;
  const deployRunSeries: Array<{ ts: number; ok: boolean; target: string }> = [];
  // Cap per-project detail/jobs lookups to keep total API calls bounded.
  // Jobs page size is intentionally maxed (per_page=100, GitLab's hard
  // cap) so even busy pipelines don't get truncated; we still record
  // `truncated` when the response is at the limit so the UI can disclose
  // the bias.
  const PIPELINE_DETAIL_LIMIT = 15;
  const JOBS_PER_PAGE = 100;
  let jobSampleTruncated = false;
  // Cursor-driven walk over the discovered projects: every project is
  // visited across runs, with the wall-clock budget bounding how many we
  // process per run. The persisted cursor (`projects.index`) lets the next
  // run resume from the next un-walked project instead of restarting at 0.
  let projectsSampled = 0;
  let nextProjectIndex = cursorStart;
  if (projects.length > 0 && cursorStart >= projects.length) nextProjectIndex = 0;

  // Source-control metric inputs collected across the walked projects;
  // mirrors the GitHub runner so buildSourceControlSummary produces
  // identical summary keys regardless of provider.
  const allLeadTimesMs: number[] = [];
  const mergedMrCandidates: Array<{
    projectId: number;
    iid: number;
    authorId: number | null;
    createdAtMs: number;
    mergedAtMs: number;
  }> = [];
  const authorCommitCounts: Record<string, number> = {};
  let totalCommitsInWindow = 0;

  for (let i = nextProjectIndex; i < projects.length; i += 1) {
    if (!withinBudget(startMs, budgetMs)) {
      nextProjectIndex = i;
      break;
    }
    const p = projects[i]!;
    let pipelineRows: Array<{
      id: number;
      status: string;
      ref: string | null;
      created_at: string;
      updated_at: string;
    }> = [];
    try {
      const pl = await fetch(
        `${baseUrl}/api/v4/projects/${p.id}/pipelines?updated_after=${since}&per_page=100`,
        { headers },
      );
      if (pl.ok) {
        pipelineRows = (await pl.json()) as typeof pipelineRows;
        pipelinesTotal += pipelineRows.length;
        pipelinesFailed += pipelineRows.filter((x) => x.status === "failed").length;
        pipelinesSucceeded += pipelineRows.filter((x) => x.status === "success").length;
        recordsCollected += pipelineRows.length;
        for (const pr of pipelineRows) {
          if (
            (pr.status === "success" || pr.status === "failed") &&
            pr.ref
          ) {
            deployRunSeries.push({
              ts: new Date(pr.updated_at).getTime(),
              ok: pr.status === "success",
              target: `${p.id}:${pr.ref}`,
            });
          }
        }
      }
    } catch {
      // ignore — project may have pipelines disabled
    }
    // Pipeline detail — gives accurate `duration` (build time only) and
    // `queued_duration` (seconds the pipeline waited before starting).
    for (const pr of pipelineRows.slice(0, PIPELINE_DETAIL_LIMIT)) {
      try {
        const dr = await fetch(
          `${baseUrl}/api/v4/projects/${p.id}/pipelines/${pr.id}`,
          { headers },
        );
        if (dr.ok) {
          const detail = (await dr.json()) as {
            duration: number | null;
            queued_duration: number | null;
          };
          if (typeof detail.duration === "number" && detail.duration > 0) {
            buildDurationsMs.push(detail.duration * 1000);
          }
          if (
            typeof detail.queued_duration === "number" &&
            detail.queued_duration >= 0
          ) {
            queueTimesMs.push(detail.queued_duration * 1000);
          }
        }
      } catch {
        // ignore — single pipeline detail failure shouldn't sink the run
      }
      // Job-level retries on this pipeline → flaky-test rate. GitLab
      // marks the *original* job's `retried: true` when a retry exists;
      // the retry job itself is the one that may have succeeded.
      try {
        const jr = await fetch(
          `${baseUrl}/api/v4/projects/${p.id}/pipelines/${pr.id}/jobs?per_page=${JOBS_PER_PAGE}`,
          { headers },
        );
        if (jr.ok) {
          const jobs = (await jr.json()) as Array<{
            name: string;
            status: string;
            retried: boolean;
          }>;
          if (jobs.length >= JOBS_PER_PAGE) {
            // GitLab caps a single page at 100; if we hit that ceiling
            // there are likely more jobs we didn't see, so flag the
            // sample as truncated.
            jobSampleTruncated = true;
          }
          // Group by name: if any attempt was retried and final attempt
          // succeeded, count as a flaky pass on retry. The denominator
          // for flaky-test rate is the number of distinct job-groups
          // observed in the window so the metric is a proper "rate of
          // flakiness across all CI work" matching GitHub/CircleCI.
          const byName = new Map<string, typeof jobs>();
          for (const j of jobs) {
            const arr = byName.get(j.name) ?? [];
            arr.push(j);
            byName.set(j.name, arr);
          }
          totalJobsObserved += byName.size;
          for (const arr of byName.values()) {
            const anyRetried = arr.some((x) => x.retried);
            if (!anyRetried) continue;
            runsWithRetries += 1;
            const finalAttempt = arr.find((x) => !x.retried);
            if (finalAttempt && finalAttempt.status === "success") {
              flakyRetrySuccesses += 1;
            }
          }
        }
      } catch {
        // ignore — jobs endpoint may be restricted or empty
      }
    }
    try {
      const mr = await fetch(
        `${baseUrl}/api/v4/projects/${p.id}/merge_requests?state=merged&updated_after=${since}&per_page=30`,
        { headers },
      );
      if (mr.ok) {
        const rows = (await mr.json()) as Array<{
          iid: number;
          author?: { id?: number };
          created_at: string;
          merged_at: string | null;
        }>;
        for (const m of rows) {
          if (m.merged_at) {
            const mergedMs = new Date(m.merged_at).getTime();
            // Bound to the 30-day window — `updated_after` lets in older
            // MRs that were just touched; we only want fresh merges.
            if (mergedMs >= sinceMsGl) {
              mrsMerged += 1;
              const createdMs = new Date(m.created_at).getTime();
              const lead = mergedMs - createdMs;
              if (lead > 0) {
                mrLeadSumMs += lead;
                mrLeadCount += 1;
                mrLeadTimesMs.push(lead);
                allLeadTimesMs.push(lead);
                mergedMrCandidates.push({
                  projectId: p.id,
                  iid: m.iid,
                  authorId: m.author?.id ?? null,
                  createdAtMs: createdMs,
                  mergedAtMs: mergedMs,
                });
              }
            }
          }
        }
      }
    } catch {
      // ignore
    }
    // Project-level commits in the window — feeds commit frequency + bus
    // factor. One page (100) per project keeps cost flat; longer-tail
    // history is intentionally not paginated. Author identity prefers
    // author_email so renames in commit names don't double-count people.
    try {
      const cr = await fetch(
        `${baseUrl}/api/v4/projects/${p.id}/repository/commits?since=${since}&per_page=100`,
        { headers },
      );
      if (cr.ok) {
        const rows = (await cr.json()) as Array<{
          author_email?: string;
          author_name?: string;
        }>;
        for (const c of rows) {
          totalCommitsInWindow += 1;
          const id = c.author_email ?? c.author_name ?? "unknown";
          authorCommitCounts[id] = (authorCommitCounts[id] ?? 0) + 1;
        }
        recordsCollected += rows.length;
      }
    } catch {
      // ignore — project may not have repository access for this token
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
    projectsSampled += 1;
    nextProjectIndex = i + 1;
    await ctx.checkpoint?.({
      cursors: {
        projects: { index: nextProjectIndex, total: projects.length },
      },
      coverage: {
        projects: {
          total: projects.length,
          sampled: projectsSampled,
          remaining: Math.max(0, projects.length - projectsSampled),
        },
      },
      recordsCollected,
    });
  }
  if (nextProjectIndex >= projects.length) nextProjectIndex = 0;

  // ---- Source-control deep-dive sample (MR detail / notes / commits)
  // See the matching block in runGithub for the cost rationale. We
  // intentionally walk PRs sequentially per project to be polite to the
  // GitLab API; on .com this stays well under the 10 req/s burst.
  const sampleN = Math.min(
    detailSampleSize(mergedMrCandidates.length, SC_LOOKBACK_DAYS),
    SC_DETAIL_HARD_CAP,
  );
  const sampledMrs = mergedMrCandidates.slice(0, sampleN);
  const prDetails: ScPrDetail[] = [];
  for (const m of sampledMrs) {
    const detail = await fetchGitlabMrDetail(token, baseUrl, m);
    if (detail) prDetails.push(detail);
  }
  recordsCollected += prDetails.length;

  const summary: Record<string, unknown> = {
    projectCount: projects.length,
    projectsDiscoveryComplete,
    pipelinesTotal,
    pipelinesSucceeded,
    pipelinesFailed,
    mrsMerged,
  };

  const sc = buildSourceControlSummary({
    prDetails,
    allLeadTimesMs,
    authorCommitCounts,
    totalCommitsInWindow,
    prsInWindow: mergedMrCandidates.length,
    prsAttemptedForDetail: sampledMrs.length,
  });
  Object.assign(summary, sc.summary);
  evidence.push(...sc.evidence);

  if (pipelinesSucceeded > 0) {
    // Deployment frequency uses successful pipelines only — failed pipelines
    // are not deployments and are accounted for in change-failure-rate.
    const deploysPerDay = pipelinesSucceeded / lookbackDays;
    summary.deploysPerDay = Number(deploysPerDay.toFixed(2));
    evidence.push({
      dimension: "process",
      signalType: deploysPerDay >= 1 ? "strength" : "gap",
      stageHint: deploysPerDay >= 5 ? 5 : deploysPerDay >= 1 ? 4 : 2,
      text: `Deployment frequency: ~${deploysPerDay.toFixed(2)} successful pipelines/day across sampled GitLab projects (${lookbackDays}d).`,
    });
  }
  if (pipelinesTotal > 0) {
    const cfr = pipelinesFailed / pipelinesTotal;
    summary.changeFailureRate = Number(cfr.toFixed(3));
    evidence.push({
      dimension: "measurement",
      signalType: cfr <= 0.15 ? "strength" : "gap",
      stageHint: cfr <= 0.15 ? 4 : cfr <= 0.3 ? 3 : 2,
      text: `Change failure rate proxy: ${(cfr * 100).toFixed(1)}% of GitLab pipelines failed (${pipelinesFailed}/${pipelinesTotal}, ${lookbackDays}d).`,
    });
  }
  if (mrLeadCount > 0) {
    const avgHours = mrLeadSumMs / mrLeadCount / 3_600_000;
    summary.leadTimeHoursAvg = Number(avgHours.toFixed(1));
    const lt = percentiles(mrLeadTimesMs);
    summary.leadTimeHoursP50 = msToHours(lt.p50);
    summary.leadTimeHoursP75 = msToHours(lt.p75);
    summary.leadTimeHoursP95 = msToHours(lt.p95);
    evidence.push({
      dimension: "process",
      signalType: avgHours <= 48 ? "strength" : "gap",
      stageHint: avgHours <= 24 ? 5 : avgHours <= 48 ? 4 : avgHours <= 168 ? 3 : 2,
      text: `Lead time for changes: avg ${avgHours.toFixed(1)}h, p50 ${msToHours(lt.p50)?.toFixed(1)}h / p75 ${msToHours(lt.p75)?.toFixed(1)}h / p95 ${msToHours(lt.p95)?.toFixed(1)}h from MR open to merge (n=${mrLeadCount}).`,
    });
  }

  // ---- CI/CD build quality (GitLab) ----------------------------------
  const bd = percentiles(buildDurationsMs);
  if (bd.count > 0) {
    summary.buildDurationMinutesP50 = msToMinutes(bd.p50);
    summary.buildDurationMinutesP75 = msToMinutes(bd.p75);
    summary.buildDurationMinutesP95 = msToMinutes(bd.p95);
    summary.buildDurationSampleSize = bd.count;
    const p95min = msToMinutes(bd.p95) ?? 0;
    evidence.push({
      dimension: "measurement",
      signalType: p95min <= 15 ? "strength" : "gap",
      stageHint: p95min <= 10 ? 5 : p95min <= 15 ? 4 : p95min <= 30 ? 3 : 2,
      text: `CI build duration: p50 ${msToMinutes(bd.p50)?.toFixed(1)}m / p75 ${msToMinutes(bd.p75)?.toFixed(1)}m / p95 ${p95min.toFixed(1)}m (n=${bd.count}, 30d).`,
    });
  }
  const qt = percentiles(queueTimesMs);
  if (qt.count > 0) {
    summary.queueTimeMinutesP50 = msToMinutes(qt.p50);
    summary.queueTimeMinutesP75 = msToMinutes(qt.p75);
    summary.queueTimeSampleSize = qt.count;
    const p75min = msToMinutes(qt.p75) ?? 0;
    evidence.push({
      dimension: "measurement",
      signalType: p75min <= 1 ? "strength" : "gap",
      stageHint: p75min <= 1 ? 5 : p75min <= 5 ? 4 : p75min <= 15 ? 3 : 2,
      text: `CI queue time: p50 ${msToMinutes(qt.p50)?.toFixed(2)}m / p75 ${p75min.toFixed(2)}m before pipeline starts (n=${qt.count}, 30d).`,
    });
  }
  if (pipelinesTotal > 0) {
    const successRate = pipelinesSucceeded / pipelinesTotal;
    summary.buildSuccessRate = Number(successRate.toFixed(3));
    evidence.push({
      dimension: "measurement",
      signalType: successRate >= 0.9 ? "strength" : "gap",
      stageHint:
        successRate >= 0.95 ? 5 : successRate >= 0.9 ? 4 : successRate >= 0.75 ? 3 : 2,
      text: `Build success rate: ${(successRate * 100).toFixed(1)}% of GitLab pipelines succeeded (${pipelinesSucceeded}/${pipelinesTotal}, 30d).`,
    });
    // Harmonized flaky-test rate: numerator = job-groups that passed on
    // retry of the same SHA; denominator = total job-groups observed in
    // the window. Closest to the PRD wording "jobs that pass on retry of
    // same SHA" since GitLab is the only provider exposing job-level
    // retry semantics cheaply (`retried: true` on /pipelines/:id/jobs).
    if (totalJobsObserved > 0) {
      const flakyRate = flakyRetrySuccesses / totalJobsObserved;
      summary.flakyTestRate = Number(flakyRate.toFixed(3));
      summary.flakyRetrySuccesses30d = flakyRetrySuccesses;
      summary.flakyDenominator30d = totalJobsObserved;
      summary.flakyDenominatorUnit = "job_groups";
      summary.runsWithRetries30d = runsWithRetries;
      summary.jobsObserved30d = totalJobsObserved;
      if (jobSampleTruncated) {
        summary.jobSampleTruncated = true;
        summary.jobSampleTruncatedReason = `One or more sampled GitLab pipelines returned ${JOBS_PER_PAGE}+ jobs on the first page (GitLab's hard cap); flaky/build percentiles reflect that cap and may under-count jobs in very large pipelines.`;
      }
      // Emit even at 0% so a strong "no flakes" result is visible.
      evidence.push({
        dimension: "measurement",
        signalType: flakyRate <= 0.02 ? "strength" : "gap",
        stageHint: flakyRate <= 0.01 ? 5 : flakyRate <= 0.05 ? 3 : 2,
        text:
          flakyRetrySuccesses === 0
            ? `Flaky CI rate: 0% — no GitLab jobs needed a passing retry on the same SHA in the last 30 days (n=${totalJobsObserved}).`
            : `Flaky CI rate: ${(flakyRate * 100).toFixed(1)}% of GitLab jobs passed on retry of the same SHA (${flakyRetrySuccesses}/${totalJobsObserved}, 30d).`,
      });
    } else {
      summary.flakyTestRate = null;
      summary.flakyTestRateUnavailableReason =
        "No jobs observed in the sampled GitLab pipelines (30d) — increase project sample or pipeline-detail limit to enable.";
    }
  }

  // ---- MTTR (GitLab) --------------------------------------------------
  const deployMttrSeries = deployFailureMttrMs(deployRunSeries);
  if (deployMttrSeries.length > 0) {
    const avgMs =
      deployMttrSeries.reduce((s, x) => s + x, 0) / deployMttrSeries.length;
    const mttrHours = avgMs / 3_600_000;
    const dp = percentiles(deployMttrSeries);
    summary.mttrHoursAvg = Number(mttrHours.toFixed(1));
    summary.mttrHoursP50 = msToHours(dp.p50);
    summary.mttrHoursP95 = msToHours(dp.p95);
    summary.mttrSource = "deployment_failure";
    summary.deployFailurePairsInWindow = deployMttrSeries.length;
    evidence.push({
      dimension: "measurement",
      signalType: mttrHours <= 24 ? "strength" : "gap",
      stageHint: mttrHours <= 4 ? 5 : mttrHours <= 24 ? 4 : mttrHours <= 72 ? 3 : 2,
      text: `MTTR (deploy failure → next success): avg ${mttrHours.toFixed(1)}h, p50 ${msToHours(dp.p50)?.toFixed(1)}h / p95 ${msToHours(dp.p95)?.toFixed(1)}h across ${deployMttrSeries.length} pairs (${lookbackDays}d).`,
    });
  }
  summary.incidentIssuesInWindow = mttrCount;
  if (deployMttrSeries.length === 0) {
    if (mttrCount > 0) {
      const mttrHours = mttrSumMs / mttrCount / 3_600_000;
      summary.mttrHoursAvg = Number(mttrHours.toFixed(1));
      summary.mttrSource = "incident_issue_fallback";
      evidence.push({
        dimension: "measurement",
        signalType: mttrHours <= 24 ? "strength" : "gap",
        stageHint: mttrHours <= 4 ? 5 : mttrHours <= 24 ? 4 : mttrHours <= 72 ? 3 : 2,
        text: `MTTR (incident-issue fallback): avg ${mttrHours.toFixed(1)}h to close incident-labeled GitLab issues (n=${mttrCount}, 30d). No deploy failure→success pipeline pairs available, so this is a proxy.`,
      });
    } else {
      summary.mttrHoursAvg = null;
      summary.mttrSource = "unavailable";
      evidence.push({
        dimension: "measurement",
        signalType: "gap",
        stageHint: 1,
        text: "MTTR n/a — no deploy failure→success pipeline pairs and no incident-labeled GitLab issues in the last 30 days.",
      });
    }
  } else if (mttrCount > 0) {
    summary.incidentIssueMttrHoursAvg = Number(
      (mttrSumMs / mttrCount / 3_600_000).toFixed(1),
    );
  }

  const coverage = {
    projects: {
      total: projects.length,
      sampled: projectsSampled,
      remaining: Math.max(0, projects.length - projectsSampled),
    },
  };
  const cursors = {
    projects: { index: nextProjectIndex, total: projects.length },
  };

  return { recordsCollected, summary, evidence, cursors, coverage };
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
  ctx: ConnectorCtx = {},
): Promise<ConnectorRunResult> {
  const baseUrl = String(config.baseUrl ?? "").replace(/\/$/, "");
  const email = String(config.email ?? "");
  const project = String(config.project ?? "");
  if (!baseUrl || !email)
    return { recordsCollected: 0, summary: {}, evidence: [] };
  await assertSafeUrl(baseUrl);
  const lookbackDays = resolveLookbackDays(ctx);
  const auth = Buffer.from(`${email}:${token}`).toString("base64");
  const headers = { Authorization: `Basic ${auth}`, Accept: "application/json" };
  const projClause = project ? `project=${project} AND ` : "";
  const statusMapping = readStatusMappingFromConfig(config);
  const sprintField = String(config.sprintField ?? "customfield_10020");
  const evidence: CollectedEvidence[] = [];
  const summary: Record<string, unknown> = {};

  // ---- 1. Resolved issues with changelog + sprint info -------------------
  // expand=changelog returns the full status transition history per issue,
  // which we need for flow-efficiency / blocked-time accounting. JQL
  // accepts negative durations like `-90d`; we pass the engagement's
  // configured lookback so a long window picks up older incidents too.
  const resolvedJql = `${projClause}resolved >= -${lookbackDays}d ORDER BY resolved DESC`;
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
    text: `Jira project has ${data.total} resolved issues in the last ${lookbackDays} days — active planning process.`,
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
    summary.incidentTickets = mttrCount;
    evidence.push({
      dimension: "measurement",
      signalType: mttrHours <= 24 ? "strength" : "gap",
      stageHint: mttrHours <= 4 ? 5 : mttrHours <= 24 ? 4 : mttrHours <= 72 ? 3 : 2,
      text: `MTTR proxy: avg ${mttrHours.toFixed(1)} hours to resolve incident/bug tickets (n=${mttrCount}, ${lookbackDays}d).`,
    });
  } else {
    summary.mttrHoursAvg = null;
    evidence.push({
      dimension: "measurement",
      signalType: "gap",
      stageHint: 1,
      text: `No incident-labeled tickets found in the last ${lookbackDays} days — MTTR cannot be measured. Tag incidents with 'incident', 'outage', 'p0', or 'p1' to enable measurement.`,
    });
  }

  // Jira's search call returns a single windowed result set, so there is no
  // multi-resource walk to resume. Coverage just reports the total vs the
  // page we examined; cursors are empty.
  const coverage = {
    issues: {
      total: data.total,
      sampled: data.issues.length,
      remaining: Math.max(0, data.total - data.issues.length),
    },
  };

  return {
    recordsCollected,
    summary,
    evidence,
    coverage,
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
  ctx: ConnectorCtx = {},
): Promise<ConnectorRunResult> {
  // Batched GraphQL query for the metrics that benefit from co-location
  // (completed issues, in-progress, cycles). Backlog and recent-created
  // counters are fetched separately via `countLinearIssues` so they can
  // paginate up to 1000 items each instead of being silently capped at the
  // first 250 the inline query would have returned. Lookback is the
  // engagement-configured window; cycleSince is held at 60 days so we
  // always have at least a couple of recent cycles to derive completion
  // rate from regardless of the lookback setting.
  const lookbackDays = resolveLookbackDays(ctx);
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
  const cycleSince = new Date(
    Date.now() - Math.max(60, lookbackDays) * 86_400_000,
  ).toISOString();
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
      text: `Linear: ${teams} teams visible, ${issues.length} issues completed in the last ${lookbackDays} days.`,
    },
  ];
  const summary: Record<string, unknown> = {
    teams,
    issuesCompletedInWindow: issues.length,
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
      text: `MTTR proxy (Linear): avg ${mttrHours.toFixed(1)} hours to resolve incident-tagged issues (n=${mttrCount}, ${lookbackDays}d).`,
    });
  }

  // Single GraphQL call with `first: 100` — like Jira there is no multi-
  // resource walk to resume, so coverage just reports the page we got.
  const coverage = {
    issues: { sampled: issues.length },
  };

  return {
    recordsCollected:
      teams + issues.length + wipNodes.length + backlogResult.count,
    summary,
    evidence,
    coverage,
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
  ctx: ConnectorCtx = {},
): Promise<ConnectorRunResult> {
  const provider = String(config.provider ?? "github_actions");
  if (provider === "github_actions") {
    const out = await runGithub(token, config, ctx);
    out.evidence.push({
      dimension: "process",
      signalType: "strength",
      stageHint: 3,
      text: "CI/CD pipeline (GitHub Actions) actively in use.",
    });
    return out;
  }
  if (provider === "circleci") {
    return runCircleCi(token, config, ctx);
  }
  if (provider === "gitlab_ci") {
    // GitLab CI shares the same backend as the GitLab connector; reuse the
    // pipeline metrics path so deploy/change-fail come out normalized.
    return runGitlab(token, config, ctx);
  }
  if (provider === "jenkins") {
    const out = await runJenkins(token, config, ctx);
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
  ctx: ConnectorCtx = {},
): Promise<ConnectorRunResult> {
  const vcs = String(config.vcs ?? "github");
  const org = String(config.org ?? "");
  const project = String(config.project ?? "");
  const evidence: CollectedEvidence[] = [];
  const startMs = Date.now();
  const lookbackDays = resolveLookbackDays(ctx);
  const budgetMs = resolveBudgetMs(ctx);
  const cursorStart = readCursorIndex(ctx.priorCursors, "pipelines", "index");
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
  // CircleCI v2 pipelines API uses opaque `next_page_token` cursor pagination
  // (no page size param — fixed ~25 per page). Walk pages until either we
  // run out of budget, the page is older than the lookback window (since
  // results are returned newest-first), or we hit the end of the project's
  // history. Replaces the old single-page `limit=100` call which silently
  // capped discovery to the most recent 100 pipelines.
  const headers = { "Circle-Token": token, Accept: "application/json" };
  const sinceMs = Date.now() - lookbackDays * 86_400_000;
  const allPipelines: Array<{
    id: string;
    created_at: string;
    state: string;
    vcs?: { branch?: string | null; revision?: string | null };
  }> = [];
  let pageToken: string | null = null;
  let pipelinesDiscoveryComplete = false;
  let stoppedOnAge = false;
  while (withinBudget(startMs, budgetMs)) {
    const url = pageToken
      ? `https://circleci.com/api/v2/project/${encodeURIComponent(slug)}/pipeline?page-token=${encodeURIComponent(pageToken)}`
      : `https://circleci.com/api/v2/project/${encodeURIComponent(slug)}/pipeline`;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`CircleCI ${r.status}`);
    const data = (await r.json()) as {
      items: Array<{
        id: string;
        created_at: string;
        state: string;
        vcs?: { branch?: string | null; revision?: string | null };
      }>;
      next_page_token: string | null;
    };
    if (data.items.length === 0) {
      pipelinesDiscoveryComplete = true;
      break;
    }
    allPipelines.push(...data.items);
    // Pipelines come back newest-first, so once a page's last item is older
    // than the lookback we know we've gone past the window and can stop.
    const lastTs = new Date(data.items[data.items.length - 1]!.created_at).getTime();
    if (lastTs < sinceMs) {
      stoppedOnAge = true;
      pipelinesDiscoveryComplete = true;
      break;
    }
    if (!data.next_page_token) {
      pipelinesDiscoveryComplete = true;
      break;
    }
    pageToken = data.next_page_token;
  }
  const recent = allPipelines.filter(
    (p) => new Date(p.created_at).getTime() >= sinceMs,
  );
  void stoppedOnAge;

  // For each pipeline, fetch its workflows to determine pass/fail and
  // accumulate CI-quality series. CircleCI flags re-runs with `tag:
  // "rerun"` (or "rerun_with_ssh"), which gives us workflow-level flaky
  // detection. We additionally pull `/api/v2/workflow/{id}/job` for the
  // first CI_JOBS_WORKFLOW_LIMIT workflows to get true job-level build
  // duration and per-job flaky pass-on-retry detection (job_name + the
  // pipeline's commit SHA), matching the GitHub/GitLab approach.
  //
  // We walk every pipeline in the lookback window (no longer the old
  // top-30 slice) and break only on the wall-clock budget, persisting a
  // cursor so the next run resumes from where we stopped.
  const CI_JOBS_WORKFLOW_LIMIT = 25;
  let workflowsTotal = 0;
  let workflowsFailed = 0;
  let workflowsSucceeded = 0;
  const buildDurationsMs: number[] = [];
  let runsWithRetries = 0;
  let flakyRetrySuccesses = 0;
  const deployRunSeries: Array<{ ts: number; ok: boolean; target: string }> = [];
  // Job-level series (CircleCI v2 `/workflow/{id}/job`)
  const jobDurationsMs: number[] = [];
  type CiJobAttempt = { status: string; workflowCreatedAt: number };
  const jobGroups = new Map<string, CiJobAttempt[]>();
  let jobsObserved = 0;
  let workflowsInspectedForJobs = 0;
  let jobSampleTruncated = false;
  // Pipeline → commit SHA so flaky job grouping can use (job_name, sha)
  // exactly like GitHub. v2 /pipeline already returns vcs.revision.
  const pipelineSha = new Map<string, string>();
  let pipelinesSampled = 0;
  let nextPipelineIndex = cursorStart;
  if (recent.length > 0 && cursorStart >= recent.length) nextPipelineIndex = 0;

  for (let i = nextPipelineIndex; i < recent.length; i += 1) {
    if (!withinBudget(startMs, budgetMs)) {
      nextPipelineIndex = i;
      break;
    }
    const p = recent[i]!;
    const sha =
      ((p as { vcs?: { revision?: string | null } }).vcs?.revision ??
        "").toString();
    if (sha) pipelineSha.set(p.id, sha);
    const branch = p.vcs?.branch ?? "unknown";
    try {
      const wr = await fetch(
        `https://circleci.com/api/v2/pipeline/${p.id}/workflow`,
        { headers },
      );
      if (!wr.ok) continue;
      const w = (await wr.json()) as {
        items: Array<{
          name: string;
          status: string;
          created_at: string;
          stopped_at: string | null;
          tag?: string | null;
        }>;
      };
      workflowsTotal += w.items.length;
      workflowsFailed += w.items.filter(
        (x) => x.status === "failed" || x.status === "failing",
      ).length;
      workflowsSucceeded += w.items.filter((x) => x.status === "success").length;
      for (const wf of w.items) {
        if (wf.created_at && wf.stopped_at) {
          const dur =
            new Date(wf.stopped_at).getTime() -
            new Date(wf.created_at).getTime();
          if (dur > 0) buildDurationsMs.push(dur);
        }
        const isRerun =
          typeof wf.tag === "string" && wf.tag.startsWith("rerun");
        if (isRerun) {
          runsWithRetries += 1;
          if (wf.status === "success") flakyRetrySuccesses += 1;
        }
        if (
          wf.stopped_at &&
          (wf.status === "success" ||
            wf.status === "failed" ||
            wf.status === "failing")
        ) {
          deployRunSeries.push({
            ts: new Date(wf.stopped_at).getTime(),
            ok: wf.status === "success",
            target: `${slug}:${wf.name}:${branch}`,
          });
        }
      }
    } catch {
      // ignore individual pipeline errors
    }
  }

  // Job-level pull for the first N workflows we just observed.
  // We re-iterate `recent` and re-fetch the workflow list to pair
  // workflow ids with their pipeline SHAs cheaply, capping total job
  // calls. Each /workflow/{id}/job call returns an array of job objects
  // with started_at/stopped_at and status — enough to compute job-level
  // build duration percentiles and (job_name, sha) flaky grouping.
  let jobCallsRemaining = CI_JOBS_WORKFLOW_LIMIT;
  for (const p of recent.slice(0, 30)) {
    if (jobCallsRemaining <= 0) {
      jobSampleTruncated = true;
      break;
    }
    const sha = pipelineSha.get(p.id) ?? `pipeline:${p.id}`;
    try {
      const wr = await fetch(
        `https://circleci.com/api/v2/pipeline/${p.id}/workflow`,
        { headers },
      );
      if (!wr.ok) continue;
      const w = (await wr.json()) as {
        items: Array<{ id: string; name: string; created_at: string }>;
      };
      for (const wf of w.items) {
        if (jobCallsRemaining <= 0) {
          jobSampleTruncated = true;
          break;
        }
        jobCallsRemaining -= 1;
        workflowsInspectedForJobs += 1;
        try {
          const jr = await fetch(
            `https://circleci.com/api/v2/workflow/${wf.id}/job`,
            { headers },
          );
          if (!jr.ok) continue;
          const jdata = (await jr.json()) as {
            items: Array<{
              name: string;
              status: string;
              started_at: string | null;
              stopped_at: string | null;
            }>;
          };
          for (const j of jdata.items) {
            jobsObserved += 1;
            if (j.started_at && j.stopped_at) {
              const dur =
                new Date(j.stopped_at).getTime() -
                new Date(j.started_at).getTime();
              if (dur > 0) jobDurationsMs.push(dur);
            }
            const groupKey = `${slug}::${j.name}::${sha}`;
            const existing = jobGroups.get(groupKey) ?? [];
            existing.push({
              status: j.status,
              workflowCreatedAt: new Date(wf.created_at).getTime(),
            });
            jobGroups.set(groupKey, existing);
          }
        } catch {
          // ignore per-workflow job fetch failures
        }
      }
    } catch {
      // ignore individual pipeline errors
    }
    pipelinesSampled += 1;
    nextPipelineIndex = i + 1;
    await ctx.checkpoint?.({
      cursors: {
        pipelines: { index: nextPipelineIndex, total: recent.length },
      },
      coverage: {
        pipelines: {
          total: recent.length,
          sampled: pipelinesSampled,
          remaining: Math.max(0, recent.length - pipelinesSampled),
        },
      },
    });
  }
  if (nextPipelineIndex >= recent.length) nextPipelineIndex = 0;

  const summary: Record<string, unknown> = {
    provider: "circleci",
    pipelinesInWindow: recent.length,
    pipelinesDiscoveryComplete,
    workflowsTotal,
    workflowsSucceeded,
    workflowsFailed,
    // CircleCI's v2 API doesn't expose queue time as a first-class field
    // (it's available only via the Insights paid endpoint). We surface
    // n/a + reason so the UI can render a helpful tooltip rather than a
    // misleading 0.
    queueTimeMinutesP50: null,
    queueTimeMinutesP75: null,
    queueTimeUnavailableReason:
      "CircleCI v2 pipeline/workflow endpoints do not expose queue time. Enable Insights export or run the GitHub Actions / GitLab connector to get this.",
    // Lead-time-for-changes lives in the source-control system (PR/MR
    // open→merge), so the CircleCI connector intentionally leaves it null.
    leadTimeHoursP50: null,
    leadTimeHoursP75: null,
    leadTimeHoursP95: null,
    leadTimeUnavailableReason:
      "Lead time for changes requires source-control PR/MR data. Add a GitHub or GitLab connector for the same project to populate this.",
    // CircleCI has no incident-issue concept of its own, so MTTR is n/a from
    // this connector. Pair with a Jira/Linear/GitHub connector to fill it.
    mttrHoursAvg: null,
  };
  if (workflowsSucceeded > 0) {
    const deploysPerDay = workflowsSucceeded / lookbackDays;
    summary.deploysPerDay = Number(deploysPerDay.toFixed(2));
    evidence.push({
      dimension: "process",
      signalType: deploysPerDay >= 1 ? "strength" : "gap",
      stageHint: deploysPerDay >= 5 ? 5 : deploysPerDay >= 1 ? 4 : 2,
      text: `Deployment frequency (CircleCI ${slug}): ~${deploysPerDay.toFixed(2)} successful workflows/day (${lookbackDays}d).`,
    });
  }
  if (workflowsTotal > 0) {
    const cfr = workflowsFailed / workflowsTotal;
    const successRate = workflowsSucceeded / workflowsTotal;
    summary.changeFailureRate = Number(cfr.toFixed(3));
    summary.buildSuccessRate = Number(successRate.toFixed(3));
    evidence.push({
      dimension: "measurement",
      signalType: cfr <= 0.15 ? "strength" : "gap",
      stageHint: cfr <= 0.15 ? 4 : cfr <= 0.3 ? 3 : 2,
      text: `Change failure rate (CircleCI ${slug}): ${(cfr * 100).toFixed(1)}% (${workflowsFailed}/${workflowsTotal}).`,
    });
    evidence.push({
      dimension: "measurement",
      signalType: successRate >= 0.9 ? "strength" : "gap",
      stageHint:
        successRate >= 0.95 ? 5 : successRate >= 0.9 ? 4 : successRate >= 0.75 ? 3 : 2,
      text: `Build success rate (CircleCI ${slug}): ${(successRate * 100).toFixed(1)}% of workflows succeeded (${workflowsSucceeded}/${workflowsTotal}, 30d).`,
    });
  }
  // ---- CI build-quality percentiles ---------------------------------
  // Prefer job-level build duration (PRD-aligned) when /workflow/{id}/job
  // returned at least one job; otherwise fall back to workflow-level
  // duration computed from /pipeline/{id}/workflow.
  const useJobLevelDuration = jobDurationsMs.length > 0;
  const bd = percentiles(useJobLevelDuration ? jobDurationsMs : buildDurationsMs);
  const buildUnit = useJobLevelDuration ? "jobs" : "workflows";
  if (bd.count > 0) {
    summary.buildDurationMinutesP50 = msToMinutes(bd.p50);
    summary.buildDurationMinutesP75 = msToMinutes(bd.p75);
    summary.buildDurationMinutesP95 = msToMinutes(bd.p95);
    summary.buildDurationSampleSize = bd.count;
    summary.buildDurationUnit = buildUnit;
    const p95min = msToMinutes(bd.p95) ?? 0;
    evidence.push({
      dimension: "measurement",
      signalType: p95min <= 15 ? "strength" : "gap",
      stageHint: p95min <= 10 ? 5 : p95min <= 15 ? 4 : p95min <= 30 ? 3 : 2,
      text: `CircleCI build duration: p50 ${msToMinutes(bd.p50)?.toFixed(1)}m / p75 ${msToMinutes(bd.p75)?.toFixed(1)}m / p95 ${p95min.toFixed(1)}m (n=${bd.count} ${buildUnit}, 30d).`,
    });
  }
  if (jobsObserved > 0) {
    summary.jobsObserved30d = jobsObserved;
    summary.workflowsInspectedForJobs30d = workflowsInspectedForJobs;
    if (jobSampleTruncated) {
      summary.jobSampleTruncated = true;
      summary.jobSampleTruncatedReason = `Only the first ${CI_JOBS_WORKFLOW_LIMIT} workflows were inspected for jobs to bound API cost; flaky/build percentiles reflect that sample.`;
    }
  }
  // Flaky-test rate prefers job-level grouping by (slug, job_name, sha)
  // per the PRD ("jobs that pass on retry of same SHA"). When two or more
  // attempts of the same job exist for the same SHA across reruns/pipelines
  // and an earlier attempt failed but a later one succeeded, count it.
  // Falls back to workflow-level rerun detection when no job data was
  // collected (e.g. /workflow/{id}/job all unauthorized).
  if (jobGroups.size > 0) {
    let jobFlakyRetrySuccesses = 0;
    for (const attempts of jobGroups.values()) {
      if (attempts.length < 2) continue;
      const sorted = [...attempts].sort(
        (a, b) => a.workflowCreatedAt - b.workflowCreatedAt,
      );
      const earlierFailed = sorted
        .slice(0, -1)
        .some((a) => a.status === "failed" || a.status === "failing");
      const finalOk = sorted[sorted.length - 1]?.status === "success";
      if (earlierFailed && finalOk) jobFlakyRetrySuccesses += 1;
    }
    const denom = jobGroups.size;
    const flakyRate = jobFlakyRetrySuccesses / denom;
    summary.flakyTestRate = Number(flakyRate.toFixed(3));
    summary.flakyRetrySuccesses30d = jobFlakyRetrySuccesses;
    summary.flakyDenominator30d = denom;
    summary.flakyDenominatorUnit = "jobs";
    summary.runsWithRetries30d = runsWithRetries;
    evidence.push({
      dimension: "measurement",
      signalType: flakyRate <= 0.02 ? "strength" : "gap",
      stageHint: flakyRate <= 0.01 ? 5 : flakyRate <= 0.05 ? 3 : 2,
      text:
        jobFlakyRetrySuccesses === 0
          ? `Flaky CircleCI rate: 0% — no jobs needed a passing retry on the same SHA across ${denom} sampled (job, SHA) groups (30d).`
          : `Flaky CircleCI rate: ${(flakyRate * 100).toFixed(1)}% of (job, SHA) groups passed on retry (${jobFlakyRetrySuccesses}/${denom}, 30d).`,
    });
  } else if (workflowsTotal > 0) {
    const flakyRate = flakyRetrySuccesses / workflowsTotal;
    summary.flakyTestRate = Number(flakyRate.toFixed(3));
    summary.flakyRetrySuccesses30d = flakyRetrySuccesses;
    summary.flakyDenominator30d = workflowsTotal;
    summary.flakyDenominatorUnit = "workflows";
    summary.runsWithRetries30d = runsWithRetries;
    evidence.push({
      dimension: "measurement",
      signalType: flakyRate <= 0.02 ? "strength" : "gap",
      stageHint: flakyRate <= 0.01 ? 5 : flakyRate <= 0.05 ? 3 : 2,
      text:
        flakyRetrySuccesses === 0
          ? `Flaky CircleCI rate: 0% — no workflows needed a passing rerun on the same SHA in the last 30 days (n=${workflowsTotal}).`
          : `Flaky CircleCI rate: ${(flakyRate * 100).toFixed(1)}% of workflows passed on rerun of the same SHA (${flakyRetrySuccesses}/${workflowsTotal}, 30d).`,
    });
  } else {
    summary.flakyTestRate = null;
    summary.flakyTestRateUnavailableReason =
      "No CircleCI workflows observed in the last 30 days.";
  }
  // ---- Deploy-failure MTTR (CircleCI) -------------------------------
  const deployMttrSeries = deployFailureMttrMs(deployRunSeries);
  if (deployMttrSeries.length > 0) {
    const avgMs =
      deployMttrSeries.reduce((s, x) => s + x, 0) / deployMttrSeries.length;
    const mttrHours = avgMs / 3_600_000;
    const dp = percentiles(deployMttrSeries);
    summary.mttrHoursAvg = Number(mttrHours.toFixed(1));
    summary.mttrHoursP50 = msToHours(dp.p50);
    summary.mttrHoursP95 = msToHours(dp.p95);
    summary.mttrSource = "deployment_failure";
    summary.deployFailurePairs30d = deployMttrSeries.length;
    evidence.push({
      dimension: "measurement",
      signalType: mttrHours <= 24 ? "strength" : "gap",
      stageHint: mttrHours <= 4 ? 5 : mttrHours <= 24 ? 4 : mttrHours <= 72 ? 3 : 2,
      text: `MTTR (CircleCI deploy failure → next success): avg ${mttrHours.toFixed(1)}h, p50 ${msToHours(dp.p50)?.toFixed(1)}h / p95 ${msToHours(dp.p95)?.toFixed(1)}h across ${deployMttrSeries.length} pairs (30d).`,
    });
  } else {
    // CircleCI has no incident-issue concept of its own, so MTTR is n/a
    // from this connector unless paired with a Jira/Linear/GitHub
    // connector.
    summary.mttrHoursAvg = null;
    summary.mttrSource = "unavailable";
  }
  if (workflowsTotal === 0) {
    evidence.push({
      dimension: "process",
      signalType: "gap",
      stageHint: 1,
      text: `No CircleCI workflows found in the last ${lookbackDays} days for ${slug}.`,
    });
  }

  const coverage = {
    pipelines: {
      total: recent.length,
      sampled: pipelinesSampled,
      remaining: Math.max(0, recent.length - pipelinesSampled),
    },
  };
  const cursors = {
    pipelines: { index: nextPipelineIndex, total: recent.length },
  };

  return {
    recordsCollected: workflowsTotal + recent.length,
    summary,
    evidence,
    cursors,
    coverage,
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
  ctx: ConnectorCtx = {},
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
  const startMs = Date.now();
  const lookbackDays = resolveLookbackDays(ctx);
  const budgetMs = resolveBudgetMs(ctx);
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

  // Walk jobs as a BFS folder queue rather than recursive DFS so we can
  // (a) stop cleanly when the wall-clock budget is exhausted and
  // (b) persist the *unvisited* folder URLs as a resume cursor so the
  // next run picks up exactly where we stopped instead of re-walking the
  // entire tree from the root.
  type FolderTask = { url: string; prefix: string; depth: number };
  const MAX_DEPTH = 5;
  const collectedJobs: Array<{ fullName: string; builds: JenkinsBuild[] }> = [];

  const priorJobsCursor = readCursor(ctx.priorCursors, "jobs");
  const priorQueueRaw = priorJobsCursor.queue;
  const priorQueue: FolderTask[] = Array.isArray(priorQueueRaw)
    ? (priorQueueRaw as unknown[]).flatMap((v) => {
        if (typeof v !== "object" || v === null) return [];
        const t = v as Record<string, unknown>;
        if (typeof t.url !== "string") return [];
        return [
          {
            url: t.url,
            prefix: typeof t.prefix === "string" ? t.prefix : "",
            depth: typeof t.depth === "number" ? t.depth : 0,
          },
        ];
      })
    : [];
  const queue: FolderTask[] =
    priorQueue.length > 0 ? priorQueue : [{ url: baseUrl, prefix: "", depth: 0 }];

  let foldersWalked = 0;
  while (queue.length > 0 && withinBudget(startMs, budgetMs)) {
    const task = queue.shift()!;
    if (task.depth > MAX_DEPTH) continue;
    const r = await fetch(
      `${task.url}/api/json?tree=jobs[name,_class,builds[number,result,timestamp,duration]]`,
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
      const fullName = task.prefix ? `${task.prefix}/${j.name}` : j.name;
      if (isJenkinsFolder(j._class)) {
        queue.push({
          url: `${task.url}/job/${encodeURIComponent(j.name)}`,
          prefix: fullName,
          depth: task.depth + 1,
        });
      } else {
        if (jobFilter && !jobFilter.test(fullName)) continue;
        collectedJobs.push({
          fullName,
          builds: Array.isArray(j.builds) ? j.builds : [],
        });
      }
    }
    foldersWalked += 1;
    // Incremental checkpoint so a kill/crash mid-walk leaves the
    // unvisited-folder queue persisted on the run row. The runner
    // debounces these writes.
    await ctx.checkpoint?.({
      cursors: {
        jobs: { queue, foldersWalked },
      },
      coverage: {
        jobs: {
          foldersWalked,
          foldersPending: queue.length,
          jobsCollected: collectedJobs.length,
        },
      },
    });
  }
  const jobsDiscoveryComplete = queue.length === 0;

  // Lookback window comes from the engagement's connectorLookbackDays.
  // Builds with `result === null` are still running and excluded from totals.
  const sinceMs = Date.now() - lookbackDays * 86_400_000;
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
    jobsDiscoveryComplete,
    buildsInWindow: total,
    buildsSucceededInWindow: succeeded,
    buildsFailedInWindow: failed,
    // Jenkins has no incident concept; MTTR comes from a paired Jira/Linear/
    // GitHub connector.
    mttrHoursAvg: null,
  };

  if (succeeded > 0) {
    const deploysPerDay = succeeded / lookbackDays;
    summary.deploysPerDay = Number(deploysPerDay.toFixed(2));
    evidence.push({
      dimension: "process",
      signalType: deploysPerDay >= 1 ? "strength" : "gap",
      stageHint: deploysPerDay >= 5 ? 5 : deploysPerDay >= 1 ? 4 : 2,
      text: `Deployment frequency (Jenkins): ~${deploysPerDay.toFixed(2)} successful builds/day across ${collectedJobs.length} jobs (${lookbackDays}d).`,
    });
  }
  if (total > 0) {
    const cfr = failed / total;
    summary.changeFailureRate = Number(cfr.toFixed(3));
    evidence.push({
      dimension: "measurement",
      signalType: cfr <= 0.15 ? "strength" : "gap",
      stageHint: cfr <= 0.15 ? 4 : cfr <= 0.3 ? 3 : 2,
      text: `Change failure rate (Jenkins): ${(cfr * 100).toFixed(1)}% (${failed}/${total} builds FAILURE/UNSTABLE, ${lookbackDays}d).`,
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
      text: `Build duration (Jenkins): avg ${avgMin.toFixed(1)} minutes per build (n=${durationCount}, ${lookbackDays}d).`,
    });
  }
  if (total === 0) {
    evidence.push({
      dimension: "process",
      signalType: "gap",
      stageHint: 1,
      text: `No Jenkins builds found in the last ${lookbackDays} days across ${collectedJobs.length} discovered jobs.`,
    });
  }

  const coverage = {
    jobs: {
      foldersWalked,
      foldersPending: queue.length,
      jobsCollected: collectedJobs.length,
    },
  };
  // Persist the unvisited-folder queue so the next run resumes from the
  // exact spot we stopped. When the walk completes (queue empty), we
  // clear the cursor so the next run starts a fresh BFS from the root.
  const cursors = jobsDiscoveryComplete
    ? { jobs: { queue: [] as FolderTask[], foldersWalked } }
    : { jobs: { queue, foldersWalked } };

  return {
    recordsCollected: total + collectedJobs.length,
    summary,
    evidence,
    cursors,
    coverage,
  };
}

// =====================================================================
// AI tooling connectors
// ---------------------------------------------------------------------
// Six sub-providers are supported under the `ai_tooling` kind:
//   - openai          (admin API, optional)
//   - anthropic       (models endpoint only — no org users API)
//   - cursor          (Cursor admin API — members + daily usage)
//   - claude_code     (Anthropic admin API — org members + usage report)
//   - windsurf        (no public admin API → CSV upload mode)
//   - amazon_q        (no public admin API → CSV upload mode)
//
// The shared metric shape across providers is:
//   - seat utilization     (active users ÷ provisioned seats)
//   - adoption rate        (active users ÷ engineerCount)
//   - acceptance rate      (suggestions accepted ÷ suggestions seen)
//
// For providers without (or alongside) a usable API, the assessor uploads a
// CSV via the existing artifacts upload flow and references the
// `csvArtifactId` in the connector config. The CSV schema is:
//   user,active_days,suggestions_seen,suggestions_accepted
// =====================================================================

const AI_TOOLING_API_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "cursor",
  "claude_code",
]);
const AI_TOOLING_CSV_ONLY_PROVIDERS = new Set(["windsurf", "amazon_q"]);

interface ParsedAdoptionCsv {
  rows: number;
  activeUsers: number;
  suggestionsSeen: number;
  suggestionsAccepted: number;
}

/**
 * Parse a CSV in the documented schema. Permissive on whitespace and
 * column order so spreadsheet-exported files Just Work. Throws on missing
 * required columns so the assessor sees a clear error.
 *
 * Required column: `user`. Optional: `active_days`, `suggestions_seen`,
 * `suggestions_accepted`. Rows with `active_days > 0` are counted as
 * active users.
 */
export function parseAdoptionCsv(text: string): ParsedAdoptionCsv {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) {
    throw new Error("CSV is empty");
  }
  // Strip a possible UTF-8 BOM from the header row.
  if (lines[0].charCodeAt(0) === 0xfeff) lines[0] = lines[0].slice(1);
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const userIdx = header.indexOf("user");
  if (userIdx === -1) {
    throw new Error('CSV missing required "user" column');
  }
  const activeIdx = header.indexOf("active_days");
  const seenIdx = header.indexOf("suggestions_seen");
  const acceptedIdx = header.indexOf("suggestions_accepted");

  let rows = 0;
  let activeUsers = 0;
  let suggestionsSeen = 0;
  let suggestionsAccepted = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const user = (cols[userIdx] ?? "").trim();
    if (!user) continue;
    rows += 1;
    const active = activeIdx >= 0 ? Number(cols[activeIdx]) : NaN;
    if (Number.isFinite(active) && active > 0) activeUsers += 1;
    if (seenIdx >= 0) {
      const n = Number(cols[seenIdx]);
      if (Number.isFinite(n) && n > 0) suggestionsSeen += n;
    }
    if (acceptedIdx >= 0) {
      const n = Number(cols[acceptedIdx]);
      if (Number.isFinite(n) && n > 0) suggestionsAccepted += n;
    }
  }
  return { rows, activeUsers, suggestionsSeen, suggestionsAccepted };
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === ",") {
        out.push(cur);
        cur = "";
      } else if (ch === '"' && cur.length === 0) {
        inQuotes = true;
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out;
}

/**
 * Shared adoption-rate evidence emitter used by every AI-tooling
 * sub-provider so the People-dimension signal stays consistent across the
 * five providers. `activeUsers` is the count of engineers with measurable
 * usage in the recent window; `engineerCount` is the denominator from
 * connector config (or 0 when the assessor hasn't supplied it).
 */
export function computeAdoptionEvidence(
  activeUsers: number | null,
  engineerCount: number,
  providerLabel: string,
  activeUsersLabel: string,
): { evidence: CollectedEvidence; adoptionPct: number | null } {
  if (activeUsers === null) {
    return {
      adoptionPct: null,
      evidence: {
        dimension: "people",
        signalType: "gap",
        stageHint: 2,
        text: `AI tool adoption rate not measurable for ${providerLabel} via API alone. Upload a usage CSV (csvArtifactId) and set engineerCount, or rely on the adoption-survey module.`,
      },
    };
  }
  if (engineerCount <= 0) {
    return {
      adoptionPct: null,
      evidence: {
        dimension: "people",
        signalType: "quote",
        text: `AI tool reach: ${activeUsers} ${activeUsersLabel}. Set engineerCount in connector config to compute adoption %.`,
      },
    };
  }
  const pct = Math.min(100, (activeUsers / engineerCount) * 100);
  return {
    adoptionPct: pct,
    evidence: {
      dimension: "people",
      signalType: pct >= 50 ? "strength" : "gap",
      stageHint: pct >= 80 ? 5 : pct >= 50 ? 4 : pct >= 20 ? 3 : 2,
      text: `AI tool adoption (${providerLabel}): ~${pct.toFixed(0)}% (${activeUsers} ${activeUsersLabel} / ${engineerCount} engineers).`,
    },
  };
}

/**
 * Acceptance-rate evidence emitter. `seen` is the number of AI suggestions
 * the IDE/tool surfaced; `accepted` is the number actually inserted into
 * code. Quietly returns null when seen=0 — that's a "no usage data" case,
 * not an acceptance signal.
 */
function computeAcceptanceEvidence(
  accepted: number,
  seen: number,
  providerLabel: string,
): { evidence: CollectedEvidence | null; acceptanceRatePct: number | null } {
  if (seen <= 0) return { evidence: null, acceptanceRatePct: null };
  const pct = Math.min(100, (accepted / seen) * 100);
  return {
    acceptanceRatePct: pct,
    evidence: {
      dimension: "tooling",
      signalType: pct >= 30 ? "strength" : "gap",
      stageHint: pct >= 50 ? 4 : pct >= 30 ? 3 : 2,
      text: `${providerLabel} suggestion acceptance: ~${pct.toFixed(0)}% (${accepted} accepted / ${seen} shown).`,
    },
  };
}

/**
 * Load the text content of a previously-uploaded artifact by id, scoped
 * to the engagement attached to the connector. Returns null when the
 * artifact doesn't exist or the engagement doesn't match (defence in depth
 * — connector config is per-engagement, but we still verify here).
 */
async function loadCsvArtifactText(
  csvArtifactId: string,
  engagementId: string | null,
): Promise<string | null> {
  if (!csvArtifactId) return null;
  const [row] = await db
    .select({
      content: artifactDocsTable.content,
      engagementId: artifactDocsTable.engagementId,
    })
    .from(artifactDocsTable)
    .where(eq(artifactDocsTable.id, csvArtifactId))
    .limit(1);
  if (!row) return null;
  if (engagementId && row.engagementId !== engagementId) return null;
  return row.content ?? "";
}

/** Friendly label for human-facing evidence text. */
function aiToolingLabel(provider: string): string {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "cursor":
      return "Cursor";
    case "claude_code":
      return "Claude Code";
    case "windsurf":
      return "Windsurf";
    case "amazon_q":
      return "Amazon Q";
    default:
      return provider;
  }
}

async function verifyAiTooling(
  token: string,
  config: Record<string, unknown>,
  ctx: ConnectorCtx,
): Promise<ConnectorVerifyResult> {
  const provider = String(config.provider ?? "openai");
  const csvArtifactId = String(config.csvArtifactId ?? "").trim();
  const engagementId = ctx.engagementId ?? null;
  const label = aiToolingLabel(provider);

  // CSV-mode preflight: if a CSV is referenced, validate it parses. This
  // overrides API verify so an assessor in a no-API shop can still
  // confirm the connector is wired up correctly.
  if (csvArtifactId) {
    const text = await loadCsvArtifactText(csvArtifactId, engagementId);
    if (text === null) {
      return { ok: false, message: "csvArtifactId not found in this engagement" };
    }
    try {
      const parsed = parseAdoptionCsv(text);
      return {
        ok: true,
        message: `${label}: CSV-upload mode active (${parsed.rows} users, ${parsed.activeUsers} active). No live API verify performed.`,
        details: { mode: "csv", ...parsed },
      };
    } catch (e) {
      return {
        ok: false,
        message: `CSV parse failed: ${e instanceof Error ? e.message : "unknown error"}`,
      };
    }
  }

  // CSV-only providers without a CSV → explicit, honest failure status.
  if (AI_TOOLING_CSV_ONLY_PROVIDERS.has(provider)) {
    return {
      ok: false,
      message: `${label} has no public admin API. Upload a usage CSV via Artifacts and reference its ID in csvArtifactId.`,
    };
  }

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
  if (provider === "cursor") {
    // Cursor admin API uses HTTP Basic auth: API key as username, empty
    // password. See https://docs.cursor.com/account/teams/admin-api
    const auth = Buffer.from(`${token}:`).toString("base64");
    const r = await fetch("https://api.cursor.com/teams/members", {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (r.ok) {
      const data = (await r.json()) as { teamMembers?: unknown[] };
      const n = Array.isArray(data.teamMembers) ? data.teamMembers.length : 0;
      return { ok: true, message: `Cursor authenticated — ${n} team members visible` };
    }
    return { ok: false, message: `Cursor ${r.status}` };
  }
  if (provider === "claude_code") {
    // Anthropic Admin API: requires an admin key (sk-ant-admin01-…). The
    // org-scoped users endpoint 401s for regular inference keys, so this
    // doubles as a "did the assessor give us an admin key?" check.
    const r = await fetch("https://api.anthropic.com/v1/organizations/users?limit=1", {
      headers: { "x-api-key": token, "anthropic-version": "2023-06-01" },
    });
    if (r.ok) {
      return { ok: true, message: "Claude Code authenticated (Anthropic admin key)" };
    }
    if (r.status === 401 || r.status === 403) {
      return {
        ok: false,
        message: `Claude Code: token lacks admin scope (${r.status}). Use an admin API key (sk-ant-admin01-…) or switch to CSV mode.`,
      };
    }
    return { ok: false, message: `Claude Code ${r.status}` };
  }
  if (provider === "copilot") {
    return verifyCopilot(token, config);
  }
  return { ok: true, message: `Token recorded for ${provider} (no live verify available)` };
}

interface ProviderRunOutcome {
  /** Number of provisioned seats (org members on the AI tool). */
  seatsProvisioned: number | null;
  /** Engineers with measurable usage in the recent window. */
  activeUsers: number | null;
  /** Suggestions surfaced by the tool. */
  suggestionsSeen: number;
  /** Suggestions accepted into code. */
  suggestionsAccepted: number;
  /** Free-form details to merge into the run summary. */
  details: Record<string, unknown>;
  /** Records counted toward the run total (HTTP responses, CSV rows, etc). */
  recordsCollected: number;
  /** Provider-specific evidence rows (e.g. tooling-dimension reach signal). */
  extraEvidence: CollectedEvidence[];
  /** Mode the run executed in — drives the headline summary text. */
  mode: "api" | "csv" | "none";
}

async function runAiToolingOpenAI(token: string): Promise<ProviderRunOutcome> {
  let modelCount = 0;
  let users: number | null = null;
  let records = 0;
  const r = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.ok) {
    const data = (await r.json()) as { data: unknown[] };
    modelCount = data.data.length;
    records += modelCount;
  }
  try {
    const ur = await fetch(
      "https://api.openai.com/v1/organization/users?limit=100",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (ur.ok) {
      const ud = (await ur.json()) as { data: Array<{ id: string }> };
      users = ud.data.length;
      records += users;
    }
  } catch {
    // non-admin keys 403 here — that's expected.
  }
  return {
    seatsProvisioned: users,
    // OpenAI's API exposes membership but not per-user activity, so
    // we treat membership as the activity proxy. The survey module is
    // the right place for true usage adoption.
    activeUsers: users,
    suggestionsSeen: 0,
    suggestionsAccepted: 0,
    details: { modelsAvailable: modelCount, orgMembers: users },
    recordsCollected: records,
    extraEvidence: [
      {
        dimension: "tooling",
        signalType: modelCount > 0 ? "strength" : "gap",
        stageHint: modelCount > 0 ? 3 : 2,
        text: `OpenAI configured with ${modelCount} models accessible.`,
      },
    ],
    mode: "api",
  };
}

async function runAiToolingAnthropic(token: string): Promise<ProviderRunOutcome> {
  let modelCount = 0;
  const r = await fetch("https://api.anthropic.com/v1/models", {
    headers: { "x-api-key": token, "anthropic-version": "2023-06-01" },
  });
  if (r.ok) {
    const data = (await r.json()) as { data: unknown[] };
    modelCount = data.data.length;
  }
  return {
    seatsProvisioned: null,
    activeUsers: null,
    suggestionsSeen: 0,
    suggestionsAccepted: 0,
    details: { modelsAvailable: modelCount },
    recordsCollected: modelCount,
    extraEvidence: [
      {
        dimension: "tooling",
        signalType: modelCount > 0 ? "strength" : "gap",
        stageHint: modelCount > 0 ? 3 : 2,
        text: `Anthropic configured with ${modelCount} models accessible.`,
      },
    ],
    mode: "api",
  };
}

async function runAiToolingCursor(token: string): Promise<ProviderRunOutcome> {
  const auth = Buffer.from(`${token}:`).toString("base64");
  const headers: Record<string, string> = {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/json",
  };
  let seats = 0;
  let records = 0;
  try {
    const mr = await fetch("https://api.cursor.com/teams/members", { headers });
    if (mr.ok) {
      const data = (await mr.json()) as { teamMembers?: Array<{ email: string }> };
      seats = Array.isArray(data.teamMembers) ? data.teamMembers.length : 0;
      records += seats;
    }
  } catch {
    // network/permission issues fall through to the gap evidence below.
  }
  // Daily usage data over the last 30 days. Cursor's endpoint expects
  // unix-millisecond startDate/endDate. Per-day rows include per-user
  // activity counts and suggestion acceptance figures.
  const now = Date.now();
  const startDate = now - 30 * 86_400_000;
  let suggestionsSeen = 0;
  let suggestionsAccepted = 0;
  const activeEmails = new Set<string>();
  try {
    const ur = await fetch("https://api.cursor.com/teams/daily-usage-data", {
      method: "POST",
      headers,
      body: JSON.stringify({ startDate, endDate: now }),
    });
    if (ur.ok) {
      const data = (await ur.json()) as {
        data?: Array<{
          email?: string;
          isActive?: boolean;
          totalLinesAdded?: number;
          acceptedLinesAdded?: number;
          totalTabsShown?: number;
          totalTabsAccepted?: number;
        }>;
      };
      const rows = Array.isArray(data.data) ? data.data : [];
      records += rows.length;
      for (const row of rows) {
        if (row.email && (row.isActive || (row.totalLinesAdded ?? 0) > 0)) {
          activeEmails.add(row.email);
        }
        suggestionsSeen += Number(row.totalTabsShown ?? 0);
        suggestionsAccepted += Number(row.totalTabsAccepted ?? 0);
      }
    }
  } catch {
    // ignore — emit what we have.
  }
  return {
    seatsProvisioned: seats || null,
    activeUsers: activeEmails.size > 0 ? activeEmails.size : seats || null,
    suggestionsSeen,
    suggestionsAccepted,
    details: {
      seatsProvisioned: seats,
      activeUsers30d: activeEmails.size,
      suggestionsSeen,
      suggestionsAccepted,
    },
    recordsCollected: records,
    extraEvidence:
      seats > 0
        ? [
            {
              dimension: "tooling",
              signalType: "strength",
              stageHint: 3,
              text: `Cursor team has ${seats} provisioned seats; ${activeEmails.size} active in the last 30 days.`,
            },
          ]
        : [],
    mode: "api",
  };
}

async function runAiToolingClaudeCode(token: string): Promise<ProviderRunOutcome> {
  let seats = 0;
  let records = 0;
  // Org members → seat count proxy.
  try {
    const ur = await fetch(
      "https://api.anthropic.com/v1/organizations/users?limit=100",
      { headers: { "x-api-key": token, "anthropic-version": "2023-06-01" } },
    );
    if (ur.ok) {
      const data = (await ur.json()) as { data: Array<{ id: string }> };
      seats = data.data.length;
      records += seats;
    }
  } catch {
    // fall through
  }
  // Anthropic Admin usage report. We don't compute acceptance from this
  // endpoint (it surfaces tokens, not per-suggestion outcomes), but we do
  // count distinct workspaces/users with non-zero usage as the activity
  // signal for adoption.
  const activeUsers = new Set<string>();
  try {
    const ur = await fetch(
      "https://api.anthropic.com/v1/organizations/usage_report/messages?limit=100",
      { headers: { "x-api-key": token, "anthropic-version": "2023-06-01" } },
    );
    if (ur.ok) {
      const data = (await ur.json()) as {
        data?: Array<{
          api_key_id?: string;
          workspace_id?: string;
          uncached_input_tokens?: number;
        }>;
      };
      const rows = Array.isArray(data.data) ? data.data : [];
      records += rows.length;
      for (const row of rows) {
        const id = row.api_key_id ?? row.workspace_id ?? "";
        if (id && (row.uncached_input_tokens ?? 0) > 0) activeUsers.add(id);
      }
    }
  } catch {
    // ignore
  }
  return {
    seatsProvisioned: seats || null,
    activeUsers: activeUsers.size > 0 ? activeUsers.size : seats || null,
    suggestionsSeen: 0,
    suggestionsAccepted: 0,
    details: {
      orgMembers: seats,
      activeApiKeysOrWorkspaces: activeUsers.size,
    },
    recordsCollected: records,
    extraEvidence:
      seats > 0
        ? [
            {
              dimension: "tooling",
              signalType: "strength",
              stageHint: 3,
              text: `Claude Code (Anthropic org) has ${seats} provisioned members; ${activeUsers.size} active API keys/workspaces in the recent usage window.`,
            },
          ]
        : [],
    mode: "api",
  };
}

function runAiToolingFromCsv(
  provider: string,
  csv: ParsedAdoptionCsv,
): ProviderRunOutcome {
  const label = aiToolingLabel(provider);
  return {
    seatsProvisioned: csv.rows,
    activeUsers: csv.activeUsers,
    suggestionsSeen: csv.suggestionsSeen,
    suggestionsAccepted: csv.suggestionsAccepted,
    details: {
      mode: "csv",
      csvRows: csv.rows,
      csvActiveUsers: csv.activeUsers,
      csvSuggestionsSeen: csv.suggestionsSeen,
      csvSuggestionsAccepted: csv.suggestionsAccepted,
    },
    recordsCollected: csv.rows,
    extraEvidence:
      csv.rows > 0
        ? [
            {
              dimension: "tooling",
              signalType: "strength",
              stageHint: 3,
              text: `${label} usage CSV ingested: ${csv.rows} users (${csv.activeUsers} active in window).`,
            },
          ]
        : [
            {
              dimension: "tooling",
              signalType: "gap",
              stageHint: 2,
              text: `${label} usage CSV had no rows.`,
            },
          ],
    mode: "csv",
  };
}

// ---- GitHub Copilot admin / billing --------------------------------------
// Copilot exposes two org-scoped endpoints we care about:
//   GET /orgs/{org}/copilot/billing   — seat breakdown (assigned/active)
//   GET /orgs/{org}/copilot/metrics   — GA replacement for /copilot/usage,
//     daily aggregates for active users, completions, acceptance, languages.
// Both require a token whose scopes include `manage_billing:copilot`
// (classic PAT) or the equivalent fine-grained "Copilot Business" admin
// permission. We surface scope failures as actionable messages instead of
// silently degrading, since the whole point of this provider per PRD is
// to give the People + Tooling rubrics a real adoption signal.
interface CopilotBilling {
  seat_breakdown: {
    total: number;
    added_this_cycle?: number;
    pending_invitation?: number;
    pending_cancellation?: number;
    active_this_cycle?: number;
    inactive_this_cycle?: number;
  };
  seat_management_setting?: string;
  public_code_suggestions?: string;
}

interface CopilotMetricsLanguage {
  name: string;
  total_engaged_users?: number;
  total_code_suggestions?: number;
  total_code_acceptances?: number;
  total_code_lines_suggested?: number;
  total_code_lines_accepted?: number;
}

interface CopilotMetricsEditorModel {
  name: string;
  is_custom_model?: boolean;
  total_engaged_users?: number;
  languages?: CopilotMetricsLanguage[];
}

interface CopilotMetricsEditor {
  name: string;
  total_engaged_users?: number;
  models?: CopilotMetricsEditorModel[];
}

interface CopilotMetricsDay {
  date: string;
  total_active_users?: number;
  total_engaged_users?: number;
  copilot_ide_code_completions?: {
    total_engaged_users?: number;
    languages?: CopilotMetricsLanguage[];
    editors?: CopilotMetricsEditor[];
  };
}

async function copilotFetch<T>(token: string, url: string): Promise<Response | T> {
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "pulse-assessor",
    },
  });
  if (!r.ok) return r;
  return (await r.json()) as T;
}

function copilotScopeMessage(status: number, action: string): string {
  if (status === 401) {
    return `Copilot ${action}: 401 Unauthorized. The token is invalid or expired — issue a new one with the "manage_billing:copilot" scope (classic PAT) or "Copilot Business" admin permission (fine-grained).`;
  }
  if (status === 403) {
    return `Copilot ${action}: 403 Forbidden. The token authenticated but lacks the Copilot admin scope. Re-issue it with "manage_billing:copilot" (classic PAT) or grant "Copilot Business" admin on the fine-grained token, then re-verify.`;
  }
  if (status === 404) {
    return `Copilot ${action}: 404 Not Found. Either the org has no Copilot Business/Enterprise subscription, or the token cannot see it — make sure the org slug is correct and the token's owner is a Copilot admin on that org.`;
  }
  return `Copilot ${action}: ${status}`;
}

async function verifyCopilot(
  token: string,
  config: Record<string, unknown>,
): Promise<ConnectorVerifyResult> {
  const org = String(config.org ?? "").trim();
  if (!org) {
    return { ok: false, message: "GitHub organization is required for the Copilot provider." };
  }
  const result = await copilotFetch<CopilotBilling>(
    token,
    `https://api.github.com/orgs/${encodeURIComponent(org)}/copilot/billing`,
  );
  if (result instanceof Response) {
    return { ok: false, message: copilotScopeMessage(result.status, "verify") };
  }
  const total = result.seat_breakdown?.total ?? 0;
  const active = result.seat_breakdown?.active_this_cycle ?? 0;
  return {
    ok: true,
    message: `Copilot admin scope confirmed for ${org}: ${active}/${total} seats active this cycle.`,
    details: {
      org,
      seatsTotal: total,
      seatsActive: active,
      seatsInactive: result.seat_breakdown?.inactive_this_cycle ?? null,
      pendingInvitation: result.seat_breakdown?.pending_invitation ?? null,
    },
  };
}

async function runCopilot(
  token: string,
  config: Record<string, unknown>,
): Promise<ConnectorRunResult> {
  const org = String(config.org ?? "").trim();
  const engineerCount = Number(config.engineerCount ?? 0);
  const evidence: CollectedEvidence[] = [];
  const summary: Record<string, unknown> = {
    provider: "copilot",
    org: org || null,
    engineerCount: engineerCount || null,
  };
  if (!org) {
    return {
      recordsCollected: 0,
      summary,
      evidence: [
        {
          dimension: "tooling",
          signalType: "gap",
          stageHint: 1,
          text: "GitHub Copilot connector configured but no organization specified — cannot query the Copilot admin API.",
        },
      ],
    };
  }

  // 1) Billing → assigned/active seats. This also re-confirms scope at run
  //    time so we emit a clear gap row instead of a 500 when the token has
  //    been rotated/downgraded since verify.
  const billing = await copilotFetch<CopilotBilling>(
    token,
    `https://api.github.com/orgs/${encodeURIComponent(org)}/copilot/billing`,
  );
  if (billing instanceof Response) {
    return {
      recordsCollected: 0,
      summary: { ...summary, billingStatus: billing.status },
      evidence: [
        {
          dimension: "tooling",
          signalType: "gap",
          stageHint: 1,
          text: copilotScopeMessage(billing.status, "run"),
        },
      ],
    };
  }
  const seatsTotal = billing.seat_breakdown?.total ?? 0;
  const seatsActive = billing.seat_breakdown?.active_this_cycle ?? 0;
  const seatsInactive = billing.seat_breakdown?.inactive_this_cycle ?? 0;
  const pendingInvitation = billing.seat_breakdown?.pending_invitation ?? 0;
  summary.seatsTotal = seatsTotal;
  summary.seatsActiveThisCycle = seatsActive;
  summary.seatsInactiveThisCycle = seatsInactive;
  summary.pendingInvitations = pendingInvitation;

  // Seat utilization: active ÷ assigned. Tagged to Tooling because it
  // measures how well the AI tool the org pays for is actually being used.
  if (seatsTotal > 0) {
    const seatUtil = seatsActive / seatsTotal;
    summary.seatUtilizationPct = Number((seatUtil * 100).toFixed(1));
    evidence.push({
      dimension: "tooling",
      signalType: seatUtil >= 0.6 ? "strength" : "gap",
      stageHint: seatUtil >= 0.8 ? 5 : seatUtil >= 0.6 ? 4 : seatUtil >= 0.3 ? 3 : 2,
      text: `Copilot seat utilization: ${(seatUtil * 100).toFixed(0)}% (${seatsActive} active of ${seatsTotal} assigned this cycle).`,
    });
  } else {
    evidence.push({
      dimension: "tooling",
      signalType: "gap",
      stageHint: 1,
      text: `No GitHub Copilot seats assigned in org "${org}".`,
    });
  }

  // 2) Metrics → daily active users, suggestion acceptance, language mix.
  //    The GA endpoint is /copilot/metrics; the older /copilot/usage was
  //    deprecated in 2025-04. We try metrics first and fall back to usage
  //    only if the org hasn't been migrated yet.
  let metrics: CopilotMetricsDay[] | null = null;
  let usedEndpoint: string | null = null;
  const metricsResp = await copilotFetch<CopilotMetricsDay[]>(
    token,
    `https://api.github.com/orgs/${encodeURIComponent(org)}/copilot/metrics`,
  );
  if (Array.isArray(metricsResp)) {
    metrics = metricsResp;
    usedEndpoint = "metrics";
  } else if (metricsResp.status === 404) {
    // Some orgs without ≥5 active users get 404 from /metrics (the privacy
    // floor). Surface that as a clean gap rather than a transport error.
    evidence.push({
      dimension: "people",
      signalType: "gap",
      stageHint: 2,
      text: `Copilot usage metrics unavailable for "${org}" (HTTP 404). The endpoint requires at least the platform's active-user privacy floor; once enough developers actively use Copilot, daily metrics will populate.`,
    });
  } else {
    return {
      recordsCollected: 0,
      summary: { ...summary, metricsStatus: metricsResp.status },
      evidence: [
        ...evidence,
        {
          dimension: "tooling",
          signalType: "gap",
          stageHint: 1,
          text: copilotScopeMessage(metricsResp.status, "metrics"),
        },
      ],
    };
  }

  let recordsCollected = (metrics?.length ?? 0) + (seatsTotal > 0 ? 1 : 0);

  if (metrics && metrics.length > 0) {
    const days = metrics.length;
    summary.metricsDays = days;
    summary.metricsEndpoint = usedEndpoint;

    // Daily active user rate (avg active users / day across the window).
    const totalActiveSum = metrics.reduce(
      (s, d) => s + (d.total_active_users ?? 0),
      0,
    );
    const avgDau = totalActiveSum / days;
    summary.avgDailyActiveUsers = Number(avgDau.toFixed(1));

    if (engineerCount > 0) {
      const dauRate = Math.min(1, avgDau / engineerCount);
      summary.dailyActiveUserRatePct = Number((dauRate * 100).toFixed(1));
      evidence.push({
        dimension: "people",
        signalType: dauRate >= 0.5 ? "strength" : "gap",
        stageHint: dauRate >= 0.8 ? 5 : dauRate >= 0.5 ? 4 : dauRate >= 0.2 ? 3 : 2,
        text: `Copilot daily-active-user rate: ~${(dauRate * 100).toFixed(0)}% (avg ${avgDau.toFixed(1)} DAU / ${engineerCount} engineers, last ${days}d).`,
      });
    } else if (seatsTotal > 0) {
      const dauOfSeats = Math.min(1, avgDau / seatsTotal);
      summary.dailyActiveUserRatePctOfSeats = Number(
        (dauOfSeats * 100).toFixed(1),
      );
      evidence.push({
        dimension: "people",
        signalType: dauOfSeats >= 0.5 ? "strength" : "gap",
        stageHint: dauOfSeats >= 0.8 ? 5 : dauOfSeats >= 0.5 ? 4 : dauOfSeats >= 0.2 ? 3 : 2,
        text: `Copilot daily-active-user rate (vs. seats): ~${(dauOfSeats * 100).toFixed(0)}% (avg ${avgDau.toFixed(1)} DAU / ${seatsTotal} seats, last ${days}d). Set engineerCount in connector config to compare against the full engineering org instead.`,
      });
    }

    // Acceptance + lines suggested vs accepted, aggregated across all
    // editors/models/languages reported. We sum once and walk the language
    // tree once to keep this O(metrics × languages) rather than O(n²).
    let totalSuggestions = 0;
    let totalAcceptances = 0;
    let totalLinesSuggested = 0;
    let totalLinesAccepted = 0;
    const languageEngagement = new Map<string, number>();
    for (const day of metrics) {
      const completions = day.copilot_ide_code_completions;
      if (!completions) continue;
      for (const editor of completions.editors ?? []) {
        for (const model of editor.models ?? []) {
          for (const lang of model.languages ?? []) {
            totalSuggestions += lang.total_code_suggestions ?? 0;
            totalAcceptances += lang.total_code_acceptances ?? 0;
            totalLinesSuggested += lang.total_code_lines_suggested ?? 0;
            totalLinesAccepted += lang.total_code_lines_accepted ?? 0;
          }
        }
      }
      // Top-level language engagement (de-dup across editors per day).
      for (const lang of completions.languages ?? []) {
        languageEngagement.set(
          lang.name,
          (languageEngagement.get(lang.name) ?? 0) +
            (lang.total_engaged_users ?? 0),
        );
      }
    }
    summary.totalSuggestions = totalSuggestions;
    summary.totalAcceptances = totalAcceptances;
    summary.totalLinesSuggested = totalLinesSuggested;
    summary.totalLinesAccepted = totalLinesAccepted;
    recordsCollected += totalSuggestions;

    if (totalSuggestions > 0) {
      const accept = totalAcceptances / totalSuggestions;
      summary.acceptanceRatePct = Number((accept * 100).toFixed(1));
      evidence.push({
        dimension: "tooling",
        signalType: accept >= 0.25 ? "strength" : "gap",
        stageHint: accept >= 0.4 ? 5 : accept >= 0.25 ? 4 : accept >= 0.15 ? 3 : 2,
        text: `Copilot suggestion acceptance: ${(accept * 100).toFixed(1)}% (${totalAcceptances.toLocaleString()} accepted of ${totalSuggestions.toLocaleString()} suggestions, last ${days}d).`,
      });
    }
    if (totalLinesSuggested > 0) {
      const lineAccept = totalLinesAccepted / totalLinesSuggested;
      summary.lineAcceptanceRatePct = Number((lineAccept * 100).toFixed(1));
      evidence.push({
        dimension: "tooling",
        signalType: lineAccept >= 0.2 ? "strength" : "gap",
        stageHint: lineAccept >= 0.35 ? 5 : lineAccept >= 0.2 ? 4 : 3,
        text: `Copilot lines accepted vs suggested: ${totalLinesAccepted.toLocaleString()} / ${totalLinesSuggested.toLocaleString()} (${(lineAccept * 100).toFixed(1)}%, last ${days}d).`,
      });
    }

    if (languageEngagement.size > 0) {
      const top = [...languageEngagement.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      summary.topLanguages = top.map(([name, n]) => ({ name, engagedUserDays: n }));
      evidence.push({
        dimension: "tooling",
        signalType: "quote",
        text: `Copilot language footprint (last ${days}d, top by engaged-user-days): ${top
          .map(([name, n]) => `${name} (${n})`)
          .join(", ")}.`,
      });
    }
  } else if (metrics && metrics.length === 0) {
    evidence.push({
      dimension: "people",
      signalType: "gap",
      stageHint: 2,
      text: `Copilot metrics endpoint returned zero days for "${org}" — no developer activity recorded in the lookback window.`,
    });
  }

  if (engineerCount <= 0) {
    evidence.push({
      dimension: "people",
      signalType: "quote",
      text: `Set "Engineer count" on this connector so adoption % can be reported relative to the full engineering org (currently using assigned seats as the denominator).`,
    });
  }

  return {
    recordsCollected,
    summary,
    evidence,
  };
}

async function runAiTooling(
  token: string,
  config: Record<string, unknown>,
  ctx: ConnectorCtx,
): Promise<ConnectorRunResult> {
  const provider = String(config.provider ?? "openai");
  // Copilot has its own bespoke evidence shape (seat utilization, DAU rate,
  // suggestion + line acceptance, language footprint) that doesn't map onto
  // the shared ProviderRunOutcome adoption/acceptance pipeline, so it
  // short-circuits before the generic dispatcher runs.
  if (provider === "copilot") {
    return runCopilot(token, config);
  }
  const label = aiToolingLabel(provider);
  // engineerCount is the denominator for adoption rate. Assessors enter
  // this as part of connector config (or it can come from the People
  // module); when absent, we emit raw counts and an explicit gap.
  const engineerCount = Number(config.engineerCount ?? 0);
  const csvArtifactId = String(config.csvArtifactId ?? "").trim();
  const engagementId = ctx.engagementId ?? null;

  let outcome: ProviderRunOutcome;

  // CSV mode trumps API mode. If a CSV is referenced, parse it and short-
  // circuit the API path — the assessor explicitly chose this mode.
  if (csvArtifactId) {
    const text = await loadCsvArtifactText(csvArtifactId, engagementId);
    if (text === null) {
      return {
        recordsCollected: 0,
        summary: { provider, error: "csvArtifactId not found", mode: "csv" },
        evidence: [
          {
            dimension: "tooling",
            signalType: "gap",
            text: `${label} connector references csvArtifactId ${csvArtifactId} which was not found in this engagement.`,
          },
        ],
      };
    }
    try {
      outcome = runAiToolingFromCsv(provider, parseAdoptionCsv(text));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "CSV parse failed";
      return {
        recordsCollected: 0,
        summary: { provider, error: msg, mode: "csv" },
        evidence: [
          {
            dimension: "tooling",
            signalType: "gap",
            text: `${label} CSV parse failed: ${msg}`,
          },
        ],
      };
    }
  } else if (AI_TOOLING_CSV_ONLY_PROVIDERS.has(provider)) {
    return {
      recordsCollected: 0,
      summary: { provider, mode: "none", note: "CSV upload required" },
      evidence: [
        {
          dimension: "tooling",
          signalType: "gap",
          stageHint: 2,
          text: `${label} has no public admin API. Upload a usage CSV via Artifacts and set csvArtifactId in this connector's config.`,
        },
      ],
    };
  } else if (AI_TOOLING_API_PROVIDERS.has(provider)) {
    if (!token) {
      return {
        recordsCollected: 0,
        summary: { provider, error: "Token required", mode: "none" },
        evidence: [
          {
            dimension: "tooling",
            signalType: "gap",
            text: `${label} connector configured but no token saved.`,
          },
        ],
      };
    }
    if (provider === "openai") outcome = await runAiToolingOpenAI(token);
    else if (provider === "anthropic") outcome = await runAiToolingAnthropic(token);
    else if (provider === "cursor") outcome = await runAiToolingCursor(token);
    else outcome = await runAiToolingClaudeCode(token);
  } else {
    return {
      recordsCollected: 0,
      summary: { provider, error: `Unknown AI tooling provider: ${provider}` },
      evidence: [],
    };
  }

  const evidence: CollectedEvidence[] = [...outcome.extraEvidence];

  // Seat utilization: only meaningful when both seats and activeUsers are
  // present and seats > 0. Reported under tooling because it measures how
  // well the licensed footprint is being used.
  let seatUtilizationPct: number | null = null;
  if (
    outcome.seatsProvisioned !== null &&
    outcome.seatsProvisioned > 0 &&
    outcome.activeUsers !== null
  ) {
    seatUtilizationPct = Math.min(
      100,
      (outcome.activeUsers / outcome.seatsProvisioned) * 100,
    );
    evidence.push({
      dimension: "tooling",
      signalType: seatUtilizationPct >= 60 ? "strength" : "gap",
      stageHint: seatUtilizationPct >= 80 ? 4 : seatUtilizationPct >= 60 ? 3 : 2,
      text: `${label} seat utilization: ~${seatUtilizationPct.toFixed(0)}% (${outcome.activeUsers} active / ${outcome.seatsProvisioned} seats).`,
    });
  }

  // Adoption: shared helper so all five AI-tooling providers feed the same
  // People-dimension metric consistently.
  const adoption = computeAdoptionEvidence(
    outcome.activeUsers,
    engineerCount,
    label,
    "active users",
  );
  evidence.push(adoption.evidence);

  // Acceptance rate (Cursor + CSV-mode for any provider that included
  // suggestions_seen/accepted). Anthropic/OpenAI APIs don't surface this.
  const acceptance = computeAcceptanceEvidence(
    outcome.suggestionsAccepted,
    outcome.suggestionsSeen,
    label,
  );
  if (acceptance.evidence) evidence.push(acceptance.evidence);

  return {
    recordsCollected: outcome.recordsCollected,
    summary: {
      provider,
      mode: outcome.mode,
      engineerCount: engineerCount || null,
      seatsProvisioned: outcome.seatsProvisioned,
      activeUsers: outcome.activeUsers,
      seatUtilizationPct:
        seatUtilizationPct === null ? null : Number(seatUtilizationPct.toFixed(1)),
      adoptionRatePct:
        adoption.adoptionPct === null ? null : Number(adoption.adoptionPct.toFixed(1)),
      acceptanceRatePct:
        acceptance.acceptanceRatePct === null
          ? null
          : Number(acceptance.acceptanceRatePct.toFixed(1)),
      ...outcome.details,
    },
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Azure DevOps connector
// ---------------------------------------------------------------------------
// Auth: Personal Access Token sent as HTTP Basic with empty username, per
// Microsoft's documented PAT auth scheme. The default base URL is the SaaS
// host (`https://dev.azure.com`); self-hosted Azure DevOps Server is
// supported by overriding `baseUrl` in the connector config.
//
// We deliberately mirror the GitHub/GitLab connectors so the same
// dimensions/stage hints come out of the run summary — that way scoring,
// the heatmap, and DORA panels light up identically for ADO-only orgs
// without any per-kind branching downstream.
function adoAuthHeader(token: string): string {
  return `Basic ${Buffer.from(`:${token}`).toString("base64")}`;
}

async function adoFetch<T>(
  token: string,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: {
      Authorization: adoAuthHeader(token),
      Accept: "application/json",
      "User-Agent": "pulse-assessor",
      ...(init.headers ?? {}),
    },
  });
  if (!r.ok) throw new Error(`Azure DevOps ${r.status}: ${await r.text()}`);
  // ADO returns HTML for "sign-in required" with HTTP 200 when the PAT is
  // missing or invalid against an org that requires SSO; guard against
  // that by checking the content-type before parsing.
  const ct = r.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    throw new Error(
      "Azure DevOps returned a non-JSON response — usually a sign-in / SSO redirect. Confirm the PAT is valid and SSO-authorized for this org.",
    );
  }
  return (await r.json()) as T;
}

async function verifyAzureDevops(
  token: string,
  config: Record<string, unknown>,
): Promise<ConnectorVerifyResult> {
  if (!token) return { ok: false, message: "Token required" };
  const baseUrl = String(config.baseUrl ?? "https://dev.azure.com").replace(/\/$/, "");
  const org = String(config.organization ?? "").trim();
  const project = String(config.project ?? "").trim();
  if (!org) return { ok: false, message: "organization required in config" };
  try {
    await assertSafeUrl(baseUrl);
    // 1. /_apis/connectionData both authenticates and identifies the user.
    //    Returns `authenticatedUser.providerDisplayName` (and customDisplayName
    //    when set) — same shape regardless of MSA, AAD, or PAT auth.
    const conn = await adoFetch<{
      authenticatedUser?: {
        providerDisplayName?: string;
        customDisplayName?: string;
      };
    }>(
      token,
      `${baseUrl}/${encodeURIComponent(org)}/_apis/connectionData?api-version=7.1`,
    );
    const who =
      conn.authenticatedUser?.customDisplayName ||
      conn.authenticatedUser?.providerDisplayName ||
      "(unknown)";
    // 2. If a project is configured, confirm the credential can actually see
    //    it — otherwise verify would falsely report green for a PAT scoped
    //    to a different project in the same org.
    if (project) {
      try {
        await adoFetch<unknown>(
          token,
          `${baseUrl}/${encodeURIComponent(org)}/_apis/projects/${encodeURIComponent(project)}?api-version=7.1`,
        );
      } catch {
        return {
          ok: false,
          message: `Authenticated as ${who}, but cannot access project "${project}" in org "${org}".`,
        };
      }
    }
    return {
      ok: true,
      message: `Authenticated as ${who}`,
      details: { user: who, organization: org, project: project || null },
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Verify failed" };
  }
}

async function runAzureDevops(
  token: string,
  config: Record<string, unknown>,
): Promise<ConnectorRunResult> {
  const baseUrl = String(config.baseUrl ?? "https://dev.azure.com").replace(/\/$/, "");
  const org = String(config.organization ?? "").trim();
  const project = String(config.project ?? "").trim();
  const evidence: CollectedEvidence[] = [];
  if (!org || !project) {
    return {
      recordsCollected: 0,
      summary: { error: "organization and project required" },
      evidence: [
        {
          dimension: "tooling",
          signalType: "gap",
          text: "Azure DevOps connector configured but missing organization or project.",
        },
      ],
    };
  }
  await assertSafeUrl(baseUrl);
  const orgUrl = `${baseUrl}/${encodeURIComponent(org)}`;
  const projUrl = `${orgUrl}/${encodeURIComponent(project)}`;
  let recordsCollected = 0;
  const summary: Record<string, unknown> = { organization: org, project };
  const since = new Date(Date.now() - 30 * 86_400_000);

  // 1. Repos sample → top-level tooling signal.
  let repoCount = 0;
  try {
    const data = await adoFetch<{
      value: Array<{ id: string; name: string }>;
    }>(token, `${projUrl}/_apis/git/repositories?api-version=7.1`);
    repoCount = data.value.length;
    recordsCollected += repoCount;
  } catch {
    // ignore — project may not have Git repos enabled
  }
  summary.repoCount = repoCount;
  if (repoCount > 0) {
    evidence.push({
      dimension: "tooling",
      signalType: "strength",
      stageHint: 3,
      text: `Discovered ${repoCount} Azure DevOps repos in project ${project}.`,
    });
  }

  // 2. Pull requests → lead-time-for-changes proxy. We pull recently
  //    completed PRs and post-filter by closedDate to the 30-day window.
  let prsSampled = 0;
  let prsMerged = 0;
  let prLeadSumMs = 0;
  let prLeadCount = 0;
  try {
    const prs = await adoFetch<{
      value: Array<{
        pullRequestId: number;
        creationDate: string;
        closedDate: string | null;
        status: string;
      }>;
    }>(
      token,
      `${projUrl}/_apis/git/pullrequests?searchCriteria.status=completed&$top=100&api-version=7.1`,
    );
    prsSampled = prs.value.length;
    for (const p of prs.value) {
      if (!p.closedDate) continue;
      const closedAt = new Date(p.closedDate).getTime();
      if (closedAt < since.getTime()) continue;
      prsMerged += 1;
      const lead = closedAt - new Date(p.creationDate).getTime();
      if (lead > 0) {
        prLeadSumMs += lead;
        prLeadCount += 1;
      }
    }
    recordsCollected += prsSampled;
  } catch {
    // ignore — repo permissions may block PR listing
  }
  summary.prsSampled = prsSampled;
  summary.prsMerged30d = prsMerged;
  if (prLeadCount > 0) {
    const avgHours = prLeadSumMs / prLeadCount / 3_600_000;
    summary.leadTimeHoursAvg = Number(avgHours.toFixed(1));
    evidence.push({
      dimension: "process",
      signalType: avgHours <= 48 ? "strength" : "gap",
      stageHint: avgHours <= 24 ? 5 : avgHours <= 48 ? 4 : avgHours <= 168 ? 3 : 2,
      text: `Lead time for changes (Azure DevOps): avg ${avgHours.toFixed(1)} hours from PR open to complete (n=${prLeadCount}, 30d).`,
    });
  }

  // 3. Pipelines → deployment frequency + change failure rate. We sample
  //    the first 5 pipelines (matches the GitHub/GitLab budget) and pull
  //    recent runs from each, post-filtering to the 30-day window.
  let pipelineRunsTotal = 0;
  let pipelineRunsSucceeded = 0;
  let pipelineRunsFailed = 0;
  let pipelineCount = 0;
  try {
    const pipelines = await adoFetch<{
      value: Array<{ id: number; name: string }>;
    }>(token, `${projUrl}/_apis/pipelines?api-version=7.1`);
    pipelineCount = pipelines.value.length;
    for (const pipe of pipelines.value.slice(0, 5)) {
      try {
        const runs = await adoFetch<{
          value: Array<{
            id: number;
            state: string;
            result?: string;
            createdDate: string;
            finishedDate?: string;
          }>;
        }>(token, `${projUrl}/_apis/pipelines/${pipe.id}/runs?api-version=7.1`);
        for (const r of runs.value) {
          const created = new Date(r.createdDate).getTime();
          if (!Number.isFinite(created) || created < since.getTime()) continue;
          pipelineRunsTotal += 1;
          if (r.result === "succeeded") pipelineRunsSucceeded += 1;
          else if (r.result === "failed") pipelineRunsFailed += 1;
        }
        recordsCollected += runs.value.length;
      } catch {
        // ignore — pipeline may have been deleted between list & fetch
      }
    }
  } catch {
    // ignore — pipelines may not be enabled
  }
  summary.pipelineCount = pipelineCount;
  summary.pipelineRuns30d = pipelineRunsTotal;
  summary.pipelineRunsSucceeded30d = pipelineRunsSucceeded;
  summary.pipelineRunsFailed30d = pipelineRunsFailed;
  if (pipelineRunsSucceeded > 0) {
    const deploysPerDay = pipelineRunsSucceeded / 30;
    summary.deploysPerDay = Number(deploysPerDay.toFixed(2));
    evidence.push({
      dimension: "process",
      signalType: deploysPerDay >= 1 ? "strength" : "gap",
      stageHint: deploysPerDay >= 5 ? 5 : deploysPerDay >= 1 ? 4 : 2,
      text: `Deployment frequency (Azure DevOps): ~${deploysPerDay.toFixed(2)} successful pipeline runs/day across sampled pipelines (30d).`,
    });
  }
  if (pipelineRunsTotal > 0) {
    const cfr = pipelineRunsFailed / pipelineRunsTotal;
    summary.changeFailureRate = Number(cfr.toFixed(3));
    evidence.push({
      dimension: "measurement",
      signalType: cfr <= 0.15 ? "strength" : "gap",
      stageHint: cfr <= 0.15 ? 4 : cfr <= 0.3 ? 3 : 2,
      text: `Change failure rate proxy (Azure DevOps): ${(cfr * 100).toFixed(1)}% (${pipelineRunsFailed}/${pipelineRunsTotal} pipeline runs failed, 30d).`,
    });
  }

  // 4. Work items → incident MTTR proxy. Two-step: WIQL returns IDs, then
  //    we batch-fetch the actual fields. ADO uses Microsoft.VSTS.Common.
  //    ClosedDate / ResolvedDate when the process template populates them;
  //    we fall back to System.ChangedDate so MTTR isn't silently zero on
  //    Basic/Agile templates that don't set ClosedDate.
  let mttrSumMs = 0;
  let mttrCount = 0;
  let workItemTotal = 0;
  try {
    const wiql = `SELECT [System.Id] FROM WorkItems
      WHERE [System.TeamProject] = '${project.replace(/'/g, "''")}'
        AND [System.State] IN ('Closed', 'Done', 'Resolved', 'Completed')
        AND ([System.Tags] CONTAINS 'incident'
          OR [System.Tags] CONTAINS 'outage'
          OR [System.Tags] CONTAINS 'p0'
          OR [System.Tags] CONTAINS 'p1')
        AND [System.ChangedDate] >= @Today - 30`;
    const ids = await adoFetch<{ workItems: Array<{ id: number }> }>(
      token,
      `${projUrl}/_apis/wit/wiql?api-version=7.1`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: wiql }),
      },
    );
    const incidentIds = ids.workItems.slice(0, 100).map((w) => w.id);
    if (incidentIds.length > 0) {
      const fields = [
        "System.CreatedDate",
        "Microsoft.VSTS.Common.ClosedDate",
        "Microsoft.VSTS.Common.ResolvedDate",
        "System.ChangedDate",
        "System.State",
      ].join(",");
      const items = await adoFetch<{
        value: Array<{ id: number; fields: Record<string, unknown> }>;
      }>(
        token,
        `${orgUrl}/_apis/wit/workitems?ids=${incidentIds.join(",")}&fields=${encodeURIComponent(fields)}&api-version=7.1`,
      );
      for (const w of items.value) {
        const f = w.fields;
        const created = String(f["System.CreatedDate"] ?? "");
        const closed =
          (f["Microsoft.VSTS.Common.ClosedDate"] as string | undefined) ||
          (f["Microsoft.VSTS.Common.ResolvedDate"] as string | undefined) ||
          (f["System.ChangedDate"] as string | undefined) ||
          "";
        if (!created || !closed) continue;
        const dur = new Date(closed).getTime() - new Date(created).getTime();
        if (dur > 0) {
          mttrSumMs += dur;
          mttrCount += 1;
        }
      }
      workItemTotal = items.value.length;
      recordsCollected += workItemTotal;
    }
  } catch {
    // ignore — WIQL may fail on tokens without work-items read; degrades
    // to an explicit "n/a" gap below.
  }
  summary.incidentWorkItems30d = workItemTotal;
  if (mttrCount > 0) {
    const mttrHours = mttrSumMs / mttrCount / 3_600_000;
    summary.mttrHoursAvg = Number(mttrHours.toFixed(1));
    evidence.push({
      dimension: "measurement",
      signalType: mttrHours <= 24 ? "strength" : "gap",
      stageHint: mttrHours <= 4 ? 5 : mttrHours <= 24 ? 4 : mttrHours <= 72 ? 3 : 2,
      text: `MTTR proxy (Azure DevOps): avg ${mttrHours.toFixed(1)} hours to close incident-tagged work items (n=${mttrCount}, 30d).`,
    });
  } else {
    summary.mttrHoursAvg = null;
    evidence.push({
      dimension: "measurement",
      signalType: "gap",
      stageHint: 1,
      text: "MTTR n/a — no Azure DevOps work items tagged 'incident', 'outage', 'p0', or 'p1' closed in the last 30 days.",
    });
  }

  return { recordsCollected, summary, evidence };
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
        result = await verifyAiTooling(token, cfg, ctx);
        break;
      case "azure_devops":
        result = await verifyAzureDevops(token, cfg);
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
        result = await runGithub(token, cfg, ctx);
        break;
      case "gitlab":
        result = await runGitlab(token, cfg, ctx);
        break;
      case "jira":
        result = await runJira(token, cfg, ctx);
        break;
      case "linear":
        result = await runLinear(token, cfg, ctx);
        break;
      case "cicd":
        result = await runCicd(token, cfg, ctx);
        break;
      case "ai_tooling":
        result = await runAiTooling(token, cfg, ctx);
        break;
      case "azure_devops":
        result = await runAzureDevops(token, cfg);
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
