import { describe, it, expect } from "vitest";
import {
  percentile,
  percentiles,
  classifyStatus,
  classifyIssueType,
  bucketTimeInStatus,
  flowEfficiency,
  readStatusMappingFromConfig,
  DEFAULT_STATUS_MAPPING,
} from "./metrics";

describe("percentile", () => {
  it("returns null for empty input", () => {
    expect(percentile([], 0.5)).toBeNull();
  });
  it("returns the single element regardless of p", () => {
    expect(percentile([7], 0.5)).toBe(7);
    expect(percentile([7], 0.95)).toBe(7);
  });
  it("computes p50 as the median for an odd-length series", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });
  it("interpolates linearly between ranks for even-length series", () => {
    // (0,10,20,30) at p=0.5 → idx=1.5 → (10+20)/2 = 15
    expect(percentile([0, 10, 20, 30], 0.5)).toBe(15);
  });
  it("handles unsorted input", () => {
    expect(percentile([30, 0, 20, 10], 0.5)).toBe(15);
  });
  it("clamps p<=0 and p>=1 to min/max", () => {
    expect(percentile([5, 1, 9], 0)).toBe(1);
    expect(percentile([5, 1, 9], 1)).toBe(9);
  });
  it("computes p95 close to the top of the distribution", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    // n=100 → idx = 99 * 0.95 = 94.05 → between 95 and 96 → 95.05
    expect(percentile(xs, 0.95)).toBeCloseTo(95.05, 2);
  });
});

describe("percentiles triple", () => {
  it("returns null triple for empty", () => {
    const t = percentiles([]);
    expect(t).toEqual({ p50: null, p75: null, p95: null });
  });
  it("returns plausible values", () => {
    const t = percentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(t.p50).toBeCloseTo(5.5, 5);
    expect(t.p75).toBeCloseTo(7.75, 5);
    expect(t.p95).toBeCloseTo(9.55, 5);
  });
});

describe("classifyStatus", () => {
  it("classifies canonical names case-insensitively", () => {
    expect(classifyStatus("In Progress")).toBe("in_progress");
    expect(classifyStatus("BLOCKED")).toBe("blocked");
    expect(classifyStatus("Done")).toBe("done");
    expect(classifyStatus("To Do")).toBe("todo");
    expect(classifyStatus("Backlog")).toBe("todo");
  });
  it("returns null for unknown statuses", () => {
    expect(classifyStatus("Pending Customer")).toBeNull();
    expect(classifyStatus("")).toBeNull();
  });
  it("respects custom mappings", () => {
    const map = {
      ...DEFAULT_STATUS_MAPPING,
      blocked: ["pending customer"],
    };
    expect(classifyStatus("Pending Customer", map)).toBe("blocked");
    // Defaults are NOT auto-merged when the caller passes a custom map for a key.
    expect(classifyStatus("Blocked", map)).toBeNull();
  });
});

describe("readStatusMappingFromConfig", () => {
  it("falls back to defaults when no config supplied", () => {
    expect(readStatusMappingFromConfig({})).toEqual(DEFAULT_STATUS_MAPPING);
  });
  it("merges per-key overrides while keeping defaults for omitted keys", () => {
    const m = readStatusMappingFromConfig({
      statusMapping: { blocked: ["pending customer", "needs info"] },
    });
    expect(m.blocked).toEqual(["pending customer", "needs info"]);
    expect(m.todo).toEqual(DEFAULT_STATUS_MAPPING.todo);
  });
  it("ignores malformed override values", () => {
    const m = readStatusMappingFromConfig({
      statusMapping: { blocked: "oops", in_progress: [1, 2, 3] },
    });
    expect(m.blocked).toEqual(DEFAULT_STATUS_MAPPING.blocked);
    expect(m.in_progress).toEqual(DEFAULT_STATUS_MAPPING.in_progress);
  });
});

describe("bucketTimeInStatus", () => {
  it("sums durations into the right canonical buckets", () => {
    // Timeline: To Do for 1h, In Progress for 4h, Blocked for 2h, Done.
    const t0 = 0;
    const segs = [
      { status: "To Do", at: t0 },
      { status: "In Progress", at: t0 + 3_600_000 },
      { status: "Blocked", at: t0 + 5 * 3_600_000 },
      { status: "Done", at: t0 + 7 * 3_600_000 },
    ];
    const finalAt = t0 + 7 * 3_600_000;
    const b = bucketTimeInStatus(segs, finalAt);
    expect(b.todo).toBe(3_600_000);
    expect(b.active).toBe(4 * 3_600_000);
    expect(b.blocked).toBe(2 * 3_600_000);
    expect(b.done).toBe(0);
    expect(b.total).toBe(7 * 3_600_000);
  });
  it("buckets unknown statuses as 'other'", () => {
    const segs = [{ status: "Awaiting Legal Review", at: 0 }];
    const b = bucketTimeInStatus(segs, 1000);
    expect(b.other).toBe(1000);
    expect(b.total).toBe(1000);
  });
  it("returns zeros for an empty timeline", () => {
    const b = bucketTimeInStatus([], 1000);
    expect(b.total).toBe(0);
  });
});

describe("flowEfficiency", () => {
  it("returns active / (active + blocked + todo) and excludes done", () => {
    const fe = flowEfficiency({
      active: 8,
      blocked: 1,
      todo: 1,
      done: 5,
      other: 0,
      total: 15,
    });
    expect(fe).toBe(0.8);
  });
  it("returns null when there is no measurable cycle time", () => {
    const fe = flowEfficiency({
      active: 0,
      blocked: 0,
      todo: 0,
      done: 100,
      other: 0,
      total: 100,
    });
    expect(fe).toBeNull();
  });
});

describe("classifyIssueType", () => {
  it("normalises common Jira/Linear types", () => {
    expect(classifyIssueType("Bug")).toBe("bug");
    expect(classifyIssueType("Defect")).toBe("bug");
    expect(classifyIssueType("Story")).toBe("feature");
    expect(classifyIssueType("Epic")).toBe("feature");
    expect(classifyIssueType("Task")).toBe("chore");
    expect(classifyIssueType("Sub-task")).toBe("chore");
    expect(classifyIssueType("Tech Debt")).toBe("tech_debt");
    expect(classifyIssueType("Refactor")).toBe("tech_debt");
    expect(classifyIssueType("Spike")).toBe("other");
    expect(classifyIssueType(null)).toBe("other");
  });
});
