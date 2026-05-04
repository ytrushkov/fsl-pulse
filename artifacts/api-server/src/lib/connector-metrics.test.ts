import { describe, it, expect } from "vitest";
import {
  percentile,
  percentiles,
  prSizeBucket,
  bucketPrSizes,
  reworkRate,
  busFactor,
  branchLifespanStats,
  detailSampleSize,
} from "./connector-metrics";

describe("percentile", () => {
  it("returns null on empty input", () => {
    expect(percentile([], 0.5)).toBeNull();
  });

  it("returns the only value for n=1 regardless of p", () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 1)).toBe(42);
  });

  it("matches numpy linear interpolation on a known sample", () => {
    // numpy.percentile([1,2,3,4,5], [50,75,95]) → [3, 4, 4.8]
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBeCloseTo(3, 5);
    expect(percentile([1, 2, 3, 4, 5], 0.75)).toBeCloseTo(4, 5);
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBeCloseTo(4.8, 5);
  });

  it("does not depend on input order", () => {
    expect(percentile([5, 1, 4, 2, 3], 0.5)).toBeCloseTo(3, 5);
  });

  it("rejects out-of-range p", () => {
    expect(() => percentile([1, 2], 1.5)).toThrow();
    expect(() => percentile([1, 2], -0.1)).toThrow();
  });
});

describe("percentiles", () => {
  it("returns nulls and n=0 on empty input", () => {
    expect(percentiles([])).toEqual({ p50: null, p75: null, p95: null, n: 0 });
  });
  it("returns the canonical triple", () => {
    const r = percentiles([1, 2, 3, 4, 5]);
    expect(r.p50).toBeCloseTo(3, 5);
    expect(r.p75).toBeCloseTo(4, 5);
    expect(r.p95).toBeCloseTo(4.8, 5);
    expect(r.n).toBe(5);
  });
});

describe("prSizeBucket", () => {
  it("buckets at the documented boundaries", () => {
    expect(prSizeBucket(0)).toBe("xs");
    expect(prSizeBucket(10)).toBe("xs");
    expect(prSizeBucket(11)).toBe("s");
    expect(prSizeBucket(50)).toBe("s");
    expect(prSizeBucket(51)).toBe("m");
    expect(prSizeBucket(250)).toBe("m");
    expect(prSizeBucket(251)).toBe("l");
    expect(prSizeBucket(1000)).toBe("l");
    expect(prSizeBucket(1001)).toBe("xl");
    expect(prSizeBucket(1_000_000)).toBe("xl");
  });
});

describe("bucketPrSizes", () => {
  it("counts each bucket and leaves zeros for unused ones", () => {
    const dist = bucketPrSizes([
      { linesChanged: 5 },
      { linesChanged: 30 },
      { linesChanged: 30 },
      { linesChanged: 200 },
      { linesChanged: 5_000 },
    ]);
    expect(dist).toEqual({ xs: 1, s: 2, m: 1, l: 0, xl: 1 });
  });
  it("returns all zeros on empty input", () => {
    expect(bucketPrSizes([])).toEqual({ xs: 0, s: 0, m: 0, l: 0, xl: 0 });
  });
});

describe("reworkRate", () => {
  it("returns null on empty input", () => {
    expect(reworkRate([])).toBeNull();
  });
  it("counts PRs with any post-review commits", () => {
    const r = reworkRate([
      { commitsAfterFirstReview: 0 },
      { commitsAfterFirstReview: 0 },
      { commitsAfterFirstReview: 1 },
      { commitsAfterFirstReview: 5 },
    ]);
    expect(r).toBeCloseTo(0.5, 5);
  });
});

describe("busFactor", () => {
  it("returns null when there are no commits", () => {
    expect(busFactor({})).toBeNull();
    expect(busFactor({ alice: 0 })).toBeNull();
  });
  it("returns 1 when one author owns >= 50%", () => {
    expect(busFactor({ alice: 8, bob: 1, carol: 1 })).toBe(1);
    expect(busFactor({ alice: 5, bob: 3, carol: 2 })).toBe(1);
  });
  it("returns 2 when two authors are needed", () => {
    expect(busFactor({ alice: 4, bob: 3, carol: 2, dave: 1 })).toBe(2);
  });
  it("returns 3 when contributions are spread evenly", () => {
    expect(busFactor({ a: 1, b: 1, c: 1, d: 1, e: 1 })).toBe(3);
  });
  it("respects a custom threshold", () => {
    expect(busFactor({ a: 4, b: 3, c: 2, d: 1 }, 0.8)).toBe(3);
  });
});

describe("branchLifespanStats", () => {
  it("returns nulls on empty input", () => {
    expect(branchLifespanStats([])).toEqual({
      avgHours: null,
      p50Hours: null,
      p95Hours: null,
      n: 0,
    });
  });
  it("computes avg + p50 + p95 in hours", () => {
    const hour = 3_600_000;
    const r = branchLifespanStats([
      { firstCommitMs: 0, mergedAtMs: 1 * hour },
      { firstCommitMs: 0, mergedAtMs: 3 * hour },
      { firstCommitMs: 0, mergedAtMs: 5 * hour },
    ]);
    expect(r.n).toBe(3);
    expect(r.avgHours).toBeCloseTo(3, 5);
    expect(r.p50Hours).toBeCloseTo(3, 5);
    expect(r.p95Hours).toBeCloseTo(4.8, 5);
  });
  it("ignores zero/negative durations (clock skew)", () => {
    const r = branchLifespanStats([
      { firstCommitMs: 100, mergedAtMs: 50 },
      { firstCommitMs: 0, mergedAtMs: 0 },
    ]);
    expect(r.n).toBe(0);
    expect(r.avgHours).toBeNull();
  });
});

describe("detailSampleSize", () => {
  it("never exceeds the population", () => {
    expect(detailSampleSize(3, 30)).toBe(3);
  });
  it("caps at ~50 for the standard 30-day window", () => {
    expect(detailSampleSize(1000, 30)).toBe(50);
  });
  it("scales up with longer windows", () => {
    expect(detailSampleSize(1000, 90)).toBe(150);
  });
  it("floors at 10 for very short windows", () => {
    expect(detailSampleSize(1000, 1)).toBe(10);
  });
});
