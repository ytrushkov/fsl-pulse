/**
 * Shared metric primitives used by source-control connectors (GitHub,
 * GitLab) so that p50/p75/p95, PR-size buckets, rework rate, bus factor,
 * and branch lifespan are computed identically across providers.
 *
 * Keeping these in one place is important for two reasons:
 *
 * 1. The PRD §6.2 "Source Control" table defines the metrics once. If
 *    GitHub and GitLab disagreed on, say, the size-bucket boundaries the
 *    Heatmap would over- or under-credit orgs purely based on which
 *    provider they use.
 * 2. Percentile and bucketing math is easy to get wrong on small samples
 *    (n=1, n=2, ties). One unit-tested implementation prevents drift.
 */

/**
 * Linear-interpolated percentile (p in [0, 1]) over a numeric sample.
 *
 * Returns null for an empty sample — callers render this as "n/a" rather
 * than fabricating a 0 that would feed into scoring.
 *
 * Why linear interpolation? It matches the convention used by NumPy,
 * Pandas, and most "percentile" UIs the user has seen. For tiny samples
 * (n=1, n=2) it degenerates gracefully: the only value is returned, or
 * the requested point falls between two adjacent values.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  if (p < 0 || p > 1 || !Number.isFinite(p)) {
    throw new Error(`percentile: p must be in [0,1], got ${p}`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

/** Convenience: compute the canonical {p50,p75,p95} triple in one pass. */
export function percentiles(values: readonly number[]): {
  p50: number | null;
  p75: number | null;
  p95: number | null;
  n: number;
} {
  return {
    p50: percentile(values, 0.5),
    p75: percentile(values, 0.75),
    p95: percentile(values, 0.95),
    n: values.length,
  };
}

/**
 * PR/MR size buckets keyed off lines changed (additions + deletions).
 * Boundaries are the de-facto industry split popularized by Google's
 * eng productivity research and the Conventional Commits / "small PR"
 * literature. Worth keeping as-is so the heatmap is comparable across
 * connectors and engagements.
 */
export type PrSizeBucket = "xs" | "s" | "m" | "l" | "xl";

export function prSizeBucket(linesChanged: number): PrSizeBucket {
  if (linesChanged <= 10) return "xs";
  if (linesChanged <= 50) return "s";
  if (linesChanged <= 250) return "m";
  if (linesChanged <= 1000) return "l";
  return "xl";
}

export type PrSizeDistribution = Record<PrSizeBucket, number>;

export function emptySizeDistribution(): PrSizeDistribution {
  return { xs: 0, s: 0, m: 0, l: 0, xl: 0 };
}

export function bucketPrSizes(
  prs: ReadonlyArray<{ linesChanged: number }>,
): PrSizeDistribution {
  const out = emptySizeDistribution();
  for (const p of prs) out[prSizeBucket(p.linesChanged)] += 1;
  return out;
}

/**
 * Rework rate — fraction of merged PRs that received at least one
 * additional commit *after* the first review was submitted. This is the
 * most reliable provider-agnostic proxy for "code thrown away":
 *
 *  - GitHub's events API does not reliably expose `forced` push flags
 *    inside the rolling window we sample.
 *  - Per-line churn (Birgitta Boeckeler / Code Climate style) requires
 *    expensive blame walks.
 *
 * Counting "commits after first review" captures the same intent (the
 * author had to redo work that had already been examined) at one extra
 * API call per PR.
 */
export function reworkRate(
  prs: ReadonlyArray<{ commitsAfterFirstReview: number }>,
): number | null {
  if (prs.length === 0) return null;
  const reworked = prs.filter((p) => p.commitsAfterFirstReview > 0).length;
  return reworked / prs.length;
}

/**
 * Bus factor — minimum number of distinct authors whose combined commits
 * cover at least 50% of the total. A bus factor of 1 means a single
 * author owns >=50% of changes, which is the canonical risk signal. We
 * stop at the first author who pushes the cumulative share over the
 * threshold so the result matches the standard bus-factor definition.
 */
export function busFactor(
  authorCommitCounts: Record<string, number>,
  threshold = 0.5,
): number | null {
  const counts = Object.values(authorCommitCounts);
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const sorted = [...counts].sort((a, b) => b - a);
  let cum = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    cum += sorted[i];
    if (cum / total >= threshold) return i + 1;
  }
  return sorted.length;
}

/**
 * Branch lifespan in milliseconds — for each merged PR/MR, the time from
 * the first commit on the source branch to the merge timestamp. We
 * surface this as `avg` and percentiles so a single mega-stale branch
 * doesn't drag the median.
 */
export function branchLifespanStats(
  branches: ReadonlyArray<{ firstCommitMs: number; mergedAtMs: number }>,
): { avgHours: number | null; p50Hours: number | null; p95Hours: number | null; n: number } {
  const lifespans = branches
    .map((b) => b.mergedAtMs - b.firstCommitMs)
    .filter((d) => d > 0);
  if (lifespans.length === 0) {
    return { avgHours: null, p50Hours: null, p95Hours: null, n: 0 };
  }
  const sumMs = lifespans.reduce((a, b) => a + b, 0);
  const avgHours = sumMs / lifespans.length / 3_600_000;
  const p50 = percentile(lifespans, 0.5);
  const p95 = percentile(lifespans, 0.95);
  return {
    avgHours,
    p50Hours: p50 !== null ? p50 / 3_600_000 : null,
    p95Hours: p95 !== null ? p95 / 3_600_000 : null,
    n: lifespans.length,
  };
}

/**
 * Sample-size guardrails. The runners pass in their lookback window in
 * days; we cap "PRs we'll fetch detail for" so cost stays predictable
 * even for very chatty repos. The helper returns the number to take from
 * a population so the runner can also surface "sampled N of M" in its
 * provenance line.
 */
export function detailSampleSize(
  population: number,
  lookbackDays: number,
): number {
  // The cap scales linearly with the lookback window at ~50 PRs per
  // 30-day window (≈1.67/day): a 30-day run samples up to 50, a 90-day
  // run up to 150, a 7-day run gets the floor of 10. Floor exists so a
  // very short window still gives us a usable percentile distribution.
  // Runners impose a separate hard cap (SC_DETAIL_HARD_CAP) on top of
  // this to keep per-run cost bounded.
  const perDay = 50 / 30;
  const cap = Math.max(10, Math.round(perDay * lookbackDays));
  return Math.min(population, cap);
}
