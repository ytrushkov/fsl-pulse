// Shared metric helpers for connector runners. Centralised here so source-
// control and issue-tracker connectors compute percentiles and bucket time-
// in-status the same way; otherwise two runners can publish "p95 cycle time"
// numbers that mean different things and the scoring engine compares apples
// to oranges.

/**
 * Compute the requested percentile (0..1) of a numeric series using linear
 * interpolation between the two nearest ranks. Returns null for an empty
 * input so callers can degrade gracefully instead of emitting `NaN`.
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  if (p <= 0) return Math.min(...values);
  if (p >= 1) return Math.max(...values);
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const w = idx - lo;
  return sorted[lo]! * (1 - w) + sorted[hi]! * w;
}

export interface PercentileTriple {
  p50: number | null;
  p75: number | null;
  p95: number | null;
}

export function percentiles(values: number[]): PercentileTriple {
  return {
    p50: percentile(values, 0.5),
    p75: percentile(values, 0.75),
    p95: percentile(values, 0.95),
  };
}

// ---------------------------------------------------------------------------
// Issue-tracker status mapping
// ---------------------------------------------------------------------------
// Real Jira/Linear workflows have dozens of status names. The PRD's flow-
// efficiency math only needs four canonical buckets, so connectors collapse
// arbitrary status names into these four. Assessors can override the defaults
// per-connector via `config.statusMapping` for non-standard workflows.

export type CanonicalStatus = "todo" | "in_progress" | "blocked" | "done";

export interface StatusMapping {
  todo: string[];
  in_progress: string[];
  blocked: string[];
  done: string[];
}

export const DEFAULT_STATUS_MAPPING: StatusMapping = {
  todo: [
    "to do",
    "todo",
    "backlog",
    "open",
    "ready",
    "selected for development",
    "triage",
    "new",
  ],
  in_progress: [
    "in progress",
    "in development",
    "doing",
    "in review",
    "code review",
    "review",
    "started",
    "qa",
    "testing",
  ],
  blocked: ["blocked", "on hold", "waiting", "impeded", "paused"],
  done: ["done", "closed", "resolved", "completed", "shipped", "released"],
};

/**
 * Classify an arbitrary workflow status into one of the four canonical
 * buckets. Returns null when no mapping rule matches so the caller can
 * surface "unmapped status" gaps instead of silently bucketing into "other".
 */
export function classifyStatus(
  status: string,
  mapping: StatusMapping = DEFAULT_STATUS_MAPPING,
): CanonicalStatus | null {
  const s = status.toLowerCase().trim();
  if (!s) return null;
  // Order matters: check "blocked" before "in_progress" so a status named
  // "Blocked - In Review" buckets as blocked. We also use exact match (not
  // substring) so "In Progress" and "In Review (blocked)" don't collide.
  for (const k of ["blocked", "in_progress", "done", "todo"] as const) {
    if (mapping[k].some((m) => m.toLowerCase() === s)) return k;
  }
  return null;
}

/**
 * Read the optional per-connector statusMapping from the connector config.
 * Missing or malformed values fall back to DEFAULT_STATUS_MAPPING so a
 * misconfigured override never crashes a run; bad keys are simply ignored.
 */
export function readStatusMappingFromConfig(
  config: Record<string, unknown>,
): StatusMapping {
  const raw = config.statusMapping;
  if (!raw || typeof raw !== "object") return DEFAULT_STATUS_MAPPING;
  const r = raw as Record<string, unknown>;
  const merged: StatusMapping = {
    todo: [...DEFAULT_STATUS_MAPPING.todo],
    in_progress: [...DEFAULT_STATUS_MAPPING.in_progress],
    blocked: [...DEFAULT_STATUS_MAPPING.blocked],
    done: [...DEFAULT_STATUS_MAPPING.done],
  };
  for (const k of ["todo", "in_progress", "blocked", "done"] as const) {
    const v = r[k];
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      merged[k] = v as string[];
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Time-in-status accounting
// ---------------------------------------------------------------------------

export interface StatusBuckets {
  active: number;
  blocked: number;
  todo: number;
  done: number;
  other: number;
  total: number;
}

/**
 * Given an ordered timeline of (status, enteredAt) segments and a final
 * cutoff timestamp, sum the milliseconds spent in each canonical bucket.
 * The issue is assumed to remain in `segments[i].status` until
 * `segments[i+1].at` (or `finalAt` for the last segment).
 */
export function bucketTimeInStatus(
  segments: Array<{ status: string; at: number }>,
  finalAt: number,
  mapping: StatusMapping = DEFAULT_STATUS_MAPPING,
): StatusBuckets {
  const out: StatusBuckets = {
    active: 0,
    blocked: 0,
    todo: 0,
    done: 0,
    other: 0,
    total: 0,
  };
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const next = i + 1 < segments.length ? segments[i + 1]!.at : finalAt;
    const dur = Math.max(0, next - seg.at);
    if (dur === 0) continue;
    const cls = classifyStatus(seg.status, mapping);
    if (cls === "in_progress") out.active += dur;
    else if (cls === "blocked") out.blocked += dur;
    else if (cls === "todo") out.todo += dur;
    else if (cls === "done") out.done += dur;
    else out.other += dur;
    out.total += dur;
  }
  return out;
}

/**
 * Per-issue flow efficiency: active time over (active + blocked + todo).
 * "done" time is excluded because it represents post-resolution wait. Returns
 * null when the denominator is zero (issue had no measurable cycle time).
 */
export function flowEfficiency(b: StatusBuckets): number | null {
  const denom = b.active + b.blocked + b.todo;
  if (denom <= 0) return null;
  return b.active / denom;
}

// ---------------------------------------------------------------------------
// Issue type classification
// ---------------------------------------------------------------------------
// The PRD asks for the bug/feature/tech-debt/chore split. Different teams
// label these differently, so we normalise on a small set of well-known
// names. Anything that doesn't match is bucketed as "other" rather than
// silently inflating one of the canonical types.

export type CanonicalIssueType = "bug" | "feature" | "tech_debt" | "chore" | "other";

export function classifyIssueType(name: string | null | undefined): CanonicalIssueType {
  const n = (name ?? "").toLowerCase().trim();
  if (!n) return "other";
  if (n === "bug" || n === "defect" || n === "incident") return "bug";
  if (
    n === "story" ||
    n === "feature" ||
    n === "epic" ||
    n === "user story" ||
    n === "improvement"
  ) {
    return "feature";
  }
  if (
    n === "tech debt" ||
    n === "technical debt" ||
    n === "refactor" ||
    n === "tech-debt"
  ) {
    return "tech_debt";
  }
  if (n === "chore" || n === "task" || n === "sub-task" || n === "subtask") return "chore";
  return "other";
}

export type IssueTypeDistribution = Record<CanonicalIssueType, number>;

export function emptyIssueTypeDistribution(): IssueTypeDistribution {
  return { bug: 0, feature: 0, tech_debt: 0, chore: 0, other: 0 };
}
