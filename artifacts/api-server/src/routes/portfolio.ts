import { Router, type IRouter } from "express";
import { and, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import {
  db,
  engagementsTable,
  engagementMembersTable,
  scoringTable,
  engagementScoringSnapshotsTable,
  surveyInvitesTable,
  connectorsTable,
  deliverableVersionsTable,
  activityEventsTable,
  usersTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { recordActivity } from "../lib/audit";
import { STAGE_LABELS } from "../lib/rubric";

const router: IRouter = Router();

/**
 * Portfolio dashboard endpoints. Unlike /engagements/:id/* which is
 * scoped by `requireEngagementMember`, these routes need to roll up many
 * engagements at once. Authorization is therefore enforced inside the
 * handler by intersecting with `engagement_members` for the signed-in user
 * (matched by both userId and email so still-pending invites resolve once
 * the invitee logs in for the first time).
 *
 * Anonymity floor: cross-engagement aggregates that could expose a single
 * client's data are protected with the same ANONYMITY_FLOOR (5) used by
 * the survey scoring pipeline. The benchmark CSV applies the floor at the
 * cell level (industry × size × dimension) before writing any number.
 */

export const ANONYMITY_FLOOR = 5;

// Stall heuristics — calibrated from the PRD ("survey completion below
// threshold", "no connector ran in N days", "no deliverable finalized
// after N weeks"). The thresholds are intentionally generous so we don't
// flag freshly-kicked-off engagements that simply haven't generated
// signal yet.
const STALL_SURVEY_THRESHOLD = 0.5;
const STALL_CONNECTOR_DAYS = 14;
const STALL_NO_FINALIZE_DAYS = 28;
const SIZE_SMALL_MAX = 5;
const SIZE_MEDIUM_MAX = 25;

export const DIMENSIONS = [
  "tooling",
  "measurement",
  "process",
  "people",
  "governance",
  "culture",
] as const;
export type Dim = (typeof DIMENSIONS)[number];

type SizeBand = "small" | "medium" | "large";
function bandFor(teamCount: number): SizeBand {
  if (teamCount <= SIZE_SMALL_MAX) return "small";
  if (teamCount <= SIZE_MEDIUM_MAX) return "medium";
  return "large";
}

interface DimensionScoreRow {
  dimension: Dim;
  score: number;
  stage: number;
}

/**
 * RFC4180-ish CSV cell escaping with formula-injection guard. If a value
 * begins with one of `=`, `+`, `-`, `@`, tab, or carriage return, prefix
 * it with a single quote so spreadsheet apps treat it as text instead of
 * evaluating it as a formula. Then wrap in quotes and double internal
 * quotes per RFC 4180. Exported for direct unit testing.
 */
export function escapeCsvCell(v: unknown): string {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Pure heatmap aggregation: collapses dimension scores across the supplied
 * scoring rows and returns one cell per known dimension. Dimensions whose
 * sample size is below `floor` are reported as suppressed with null means
 * so callers can render "n/a" without leaking a single client's data.
 */
export function computeHeatmapCells(
  scorings: Array<{ byDimension: unknown }>,
  floor: number = ANONYMITY_FLOOR,
): Array<{
  dimension: Dim;
  meanScore: number | null;
  meanStage: number | null;
  count: number;
  suppressed: boolean;
}> {
  const sums = new Map<Dim, { score: number; stage: number; count: number }>();
  for (const dim of DIMENSIONS) {
    sums.set(dim, { score: 0, stage: 0, count: 0 });
  }
  for (const s of scorings) {
    const rows = (s.byDimension ?? []) as DimensionScoreRow[];
    for (const r of rows) {
      const acc = sums.get(r.dimension as Dim);
      if (!acc) continue;
      if (typeof r.score === "number") acc.score += r.score;
      if (typeof r.stage === "number") acc.stage += r.stage;
      acc.count += 1;
    }
  }
  return DIMENSIONS.map((dim) => {
    const acc = sums.get(dim)!;
    const suppressed = acc.count < floor;
    return {
      dimension: dim,
      meanScore:
        suppressed || acc.count === 0 ? null : acc.score / acc.count,
      meanStage:
        suppressed || acc.count === 0 ? null : acc.stage / acc.count,
      count: acc.count,
      suppressed,
    };
  });
}

/**
 * Pure benchmark-CSV builder: groups by (industry, size, dimension) and
 * emits one CSV row per bucket, replacing the numeric columns with the
 * literal token "SUPPRESSED" whenever the cell's sample size is below
 * `floor`. Industry and sizeBand labels are passed through `escapeCsvCell`,
 * so any user-controlled industry text that begins with a formula char
 * (e.g. `"=cmd"`) is neutralised before it reaches a spreadsheet.
 */
export function buildBenchmarkCsv(
  engagements: Array<{
    id: string;
    industry: string | null;
    teamCount: number;
  }>,
  scorings: Array<{ engagementId: string; byDimension: unknown }>,
  floor: number = ANONYMITY_FLOOR,
): { csv: string; emittedCells: number; suppressedCells: number } {
  const engById = new Map(engagements.map((e) => [e.id, e]));
  type Cell = { score: number; stage: number; count: number };
  const buckets = new Map<string, Cell>(); // key = industry|size|dimension
  for (const s of scorings) {
    const eng = engById.get(s.engagementId);
    if (!eng) continue;
    const industry = eng.industry?.trim() || "(unspecified)";
    const size = bandFor(eng.teamCount);
    const rows = (s.byDimension ?? []) as DimensionScoreRow[];
    for (const r of rows) {
      if (!DIMENSIONS.includes(r.dimension as Dim)) continue;
      const key = `${industry}|${size}|${r.dimension}`;
      const acc = buckets.get(key) ?? { score: 0, stage: 0, count: 0 };
      if (typeof r.score === "number") acc.score += r.score;
      if (typeof r.stage === "number") acc.stage += r.stage;
      acc.count += 1;
      buckets.set(key, acc);
    }
  }
  const header = [
    "industry",
    "sizeBand",
    "dimension",
    "engagementCount",
    "meanScore",
    "meanStage",
  ];
  const lines = [header.map(escapeCsvCell).join(",")];
  let suppressedCells = 0;
  let emittedCells = 0;
  const keys = Array.from(buckets.keys()).sort();
  for (const key of keys) {
    const acc = buckets.get(key)!;
    const [industry, size, dimension] = key.split("|");
    const suppressed = acc.count < floor;
    if (suppressed) suppressedCells += 1;
    else emittedCells += 1;
    lines.push(
      [
        industry,
        size,
        dimension,
        acc.count,
        suppressed ? "SUPPRESSED" : (acc.score / acc.count).toFixed(3),
        suppressed ? "SUPPRESSED" : (acc.stage / acc.count).toFixed(3),
      ]
        .map(escapeCsvCell)
        .join(","),
    );
  }
  return { csv: lines.join("\n") + "\n", emittedCells, suppressedCells };
}

interface OverallShape {
  score?: number;
  stage?: number;
}

interface PortfolioFilters {
  industry?: string;
  size?: SizeBand;
  from?: Date;
  to?: Date;
}

function parseFilters(q: Record<string, unknown>): PortfolioFilters {
  const f: PortfolioFilters = { ...parseDistributionFilters(q) };
  const from = typeof q.from === "string" ? Date.parse(q.from) : NaN;
  if (Number.isFinite(from)) f.from = new Date(from);
  const to = typeof q.to === "string" ? Date.parse(q.to) : NaN;
  if (Number.isFinite(to)) f.to = new Date(to);
  return f;
}

/**
 * Parse only the cohort filters (industry / size) used by the distribution
 * endpoints. Critically this does NOT read `from`/`to` — those are reserved
 * by the history endpoint to define the month range, and reusing them as
 * createdAt filters would silently exclude engagements from the snapshot.
 */
function parseDistributionFilters(
  q: Record<string, unknown>,
): Pick<PortfolioFilters, "industry" | "size"> {
  const f: Pick<PortfolioFilters, "industry" | "size"> = {};
  if (typeof q.industry === "string" && q.industry.trim()) {
    f.industry = q.industry.trim();
  }
  if (q.size === "small" || q.size === "medium" || q.size === "large") {
    f.size = q.size;
  }
  return f;
}

/**
 * Resolve every engagement id the signed-in user is a member of (matched by
 * userId OR email so pending invites work). Returns [] when the user is not
 * yet on any engagement, which short-circuits all portfolio queries safely
 * (no leak of other engagements' data).
 */
async function membershipIds(
  userId: string,
  email: string,
): Promise<string[]> {
  const rows = await db
    .select({ engagementId: engagementMembersTable.engagementId })
    .from(engagementMembersTable)
    .where(
      or(
        eq(engagementMembersTable.userId, userId),
        eq(engagementMembersTable.email, email),
      ),
    );
  return Array.from(new Set(rows.map((r) => r.engagementId)));
}

/**
 * Apply portfolio filters to a list of engagement rows. Filtering is done
 * in app code rather than SQL because sizeBand is derived from teamCount
 * and it keeps the heatmap/list/CSV using one source of truth.
 */
function applyFilters<T extends {
  industry: string | null;
  teamCount: number;
  createdAt: Date;
}>(rows: T[], f: PortfolioFilters): T[] {
  return rows.filter((r) => {
    if (f.industry && (r.industry ?? "") !== f.industry) return false;
    if (f.size && bandFor(r.teamCount) !== f.size) return false;
    if (f.from && r.createdAt < f.from) return false;
    if (f.to && r.createdAt > f.to) return false;
    return true;
  });
}

router.get("/portfolio", requireAuth, async (req, res): Promise<void> => {
  const user = req.authedUser!;
  const ids = await membershipIds(user.id, user.email);
  if (ids.length === 0) {
    res.json({
      engagements: [],
      stalledCount: 0,
      industries: [],
      generatedAt: new Date().toISOString(),
    });
    return;
  }

  // Pull every supporting table in parallel scoped to the user's membership
  // set. The aggregation work happens in JS so the sizeBand-derived filter
  // and the stall heuristics share one code path with the heatmap and CSV.
  const [
    engagements,
    scorings,
    invites,
    connectors,
    finalizedVersions,
    lastActivities,
  ] = await Promise.all([
    db
      .select()
      .from(engagementsTable)
      .where(inArray(engagementsTable.id, ids)),
    db
      .select()
      .from(scoringTable)
      .where(inArray(scoringTable.engagementId, ids)),
    db
      .select({
        engagementId: surveyInvitesTable.engagementId,
        status: surveyInvitesTable.status,
      })
      .from(surveyInvitesTable)
      .where(inArray(surveyInvitesTable.engagementId, ids)),
    db
      .select({
        engagementId: connectorsTable.engagementId,
        status: connectorsTable.status,
        lastSuccessAt: connectorsTable.lastSuccessAt,
      })
      .from(connectorsTable)
      .where(inArray(connectorsTable.engagementId, ids)),
    db
      .select({
        engagementId: deliverableVersionsTable.engagementId,
        deliverableKey: deliverableVersionsTable.deliverableKey,
        finalized: deliverableVersionsTable.finalized,
        createdAt: deliverableVersionsTable.createdAt,
      })
      .from(deliverableVersionsTable)
      .where(
        and(
          inArray(deliverableVersionsTable.engagementId, ids),
          eq(deliverableVersionsTable.finalized, true),
        ),
      ),
    db
      .select({
        engagementId: activityEventsTable.engagementId,
        // Most recent activity per engagement via window-function trick:
        // group by id later, just sort desc here.
        createdAt: activityEventsTable.createdAt,
      })
      .from(activityEventsTable)
      .where(inArray(activityEventsTable.engagementId, ids))
      .orderBy(desc(activityEventsTable.createdAt)),
  ]);

  const filtered = applyFilters(engagements, parseFilters(req.query as Record<string, unknown>));

  // Build O(1) lookup maps so the per-engagement projection stays linear.
  const scoringByEng = new Map(scorings.map((s) => [s.engagementId, s]));
  const invitesByEng = new Map<string, { sent: number; completed: number }>();
  for (const inv of invites) {
    const acc = invitesByEng.get(inv.engagementId) ?? { sent: 0, completed: 0 };
    acc.sent += 1;
    if (inv.status === "completed") acc.completed += 1;
    invitesByEng.set(inv.engagementId, acc);
  }
  const connectorsByEng = new Map<
    string,
    { total: number; healthy: number; lastRunAt: Date | null }
  >();
  for (const c of connectors) {
    const acc =
      connectorsByEng.get(c.engagementId) ??
      { total: 0, healthy: 0, lastRunAt: null as Date | null };
    acc.total += 1;
    if (c.status === "configured" || c.status === "collected" || c.status === "collecting") {
      acc.healthy += 1;
    }
    if (c.lastSuccessAt && (!acc.lastRunAt || c.lastSuccessAt > acc.lastRunAt)) {
      acc.lastRunAt = c.lastSuccessAt;
    }
    connectorsByEng.set(c.engagementId, acc);
  }
  const finalizedByEng = new Map<string, Set<string>>();
  for (const v of finalizedVersions) {
    const set = finalizedByEng.get(v.engagementId) ?? new Set<string>();
    set.add(v.deliverableKey);
    finalizedByEng.set(v.engagementId, set);
  }
  // Activities are pre-ordered desc; first row per engagementId wins.
  const lastActivityByEng = new Map<string, Date>();
  for (const a of lastActivities) {
    if (!a.engagementId) continue;
    if (!lastActivityByEng.has(a.engagementId)) {
      lastActivityByEng.set(a.engagementId, a.createdAt);
    }
  }

  const now = Date.now();
  const projection = filtered.map((eng) => {
    const scoring = scoringByEng.get(eng.id);
    const inv = invitesByEng.get(eng.id) ?? { sent: 0, completed: 0 };
    const conn =
      connectorsByEng.get(eng.id) ?? { total: 0, healthy: 0, lastRunAt: null };
    const finalizedSet = finalizedByEng.get(eng.id) ?? new Set<string>();
    const responseRate = inv.sent > 0 ? inv.completed / inv.sent : 0;

    const stallReasons: string[] = [];
    if (inv.sent > 0 && responseRate < STALL_SURVEY_THRESHOLD) {
      stallReasons.push("low_survey_response");
    }
    if (conn.total > 0) {
      const ageDays = conn.lastRunAt
        ? (now - conn.lastRunAt.getTime()) / 86400000
        : Infinity;
      if (ageDays > STALL_CONNECTOR_DAYS) stallReasons.push("stale_connectors");
    }
    const ageDaysSinceCreate = (now - eng.createdAt.getTime()) / 86400000;
    if (
      finalizedSet.size === 0 &&
      ageDaysSinceCreate > STALL_NO_FINALIZE_DAYS
    ) {
      stallReasons.push("no_finalized_deliverable");
    }

    const overall = (scoring?.overall ?? null) as OverallShape | null;
    return {
      id: eng.id,
      clientName: eng.clientName,
      sponsor: eng.sponsor,
      industry: eng.industry,
      teamCount: eng.teamCount,
      sizeBand: bandFor(eng.teamCount),
      status: eng.status,
      createdAt: eng.createdAt.toISOString(),
      updatedAt: eng.updatedAt.toISOString(),
      targetDeliveryDate: eng.targetDeliveryDate?.toISOString() ?? null,
      overallScore: typeof overall?.score === "number" ? overall.score : null,
      overallStage: typeof overall?.stage === "number" ? overall.stage : null,
      rubricVersion: scoring?.rubricVersion ?? null,
      surveyResponseRate: responseRate,
      surveySent: inv.sent,
      surveyCompleted: inv.completed,
      connectorsTotal: conn.total,
      connectorsHealthy: conn.healthy,
      lastConnectorRunAt: conn.lastRunAt?.toISOString() ?? null,
      lastActivityAt: lastActivityByEng.get(eng.id)?.toISOString() ?? null,
      finalizedDeliverableCount: finalizedSet.size,
      totalDeliverableCount: 5,
      stallReasons,
    };
  });

  // Sort newest first; UI overrides for column sorting are client-side.
  projection.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const stalledCount = projection.filter((p) => p.stallReasons.length > 0).length;
  const industries = Array.from(
    new Set(
      engagements
        .map((e) => e.industry)
        .filter((v): v is string => typeof v === "string" && v.length > 0),
    ),
  ).sort();

  res.json({
    engagements: projection,
    stalledCount,
    industries,
    generatedAt: new Date().toISOString(),
  });
});

router.get("/portfolio/heatmap", requireAuth, async (req, res): Promise<void> => {
  const user = req.authedUser!;
  const ids = await membershipIds(user.id, user.email);
  if (ids.length === 0) {
    res.json({
      cells: DIMENSIONS.map((d) => ({
        dimension: d,
        meanScore: null,
        meanStage: null,
        count: 0,
        suppressed: false,
      })),
      engagementCount: 0,
      anonymityFloor: ANONYMITY_FLOOR,
      appliedFilters: {},
      generatedAt: new Date().toISOString(),
    });
    return;
  }
  const filters = parseFilters(req.query as Record<string, unknown>);
  const [engagements, scorings] = await Promise.all([
    db.select().from(engagementsTable).where(inArray(engagementsTable.id, ids)),
    db.select().from(scoringTable).where(inArray(scoringTable.engagementId, ids)),
  ]);
  const filtered = applyFilters(engagements, filters);
  const filteredIds = new Set(filtered.map((e) => e.id));
  const inScopeScorings = scorings.filter((s) => filteredIds.has(s.engagementId));

  // Apply the anonymity floor at the dimension level: if fewer than
  // ANONYMITY_FLOOR engagements contributed to this dimension's mean, we
  // suppress the score so a tiny portfolio slice can't be reverse-engineered
  // back to a single client.
  const cells = computeHeatmapCells(inScopeScorings, ANONYMITY_FLOOR);

  res.json({
    cells,
    engagementCount: filtered.length,
    anonymityFloor: ANONYMITY_FLOOR,
    appliedFilters: {
      industry: filters.industry ?? null,
      size: filters.size ?? null,
      from: filters.from?.toISOString() ?? null,
      to: filters.to?.toISOString() ?? null,
    },
    generatedAt: new Date().toISOString(),
  });
});

/**
 * Admin-only benchmark CSV: industry × size × dimension means across the
 * entire system (not just the caller's memberships, since this is a
 * cross-portfolio anonymized export). The anonymity floor is applied at
 * every cell — a row only emits a number when at least ANONYMITY_FLOOR
 * engagements contributed to that specific (industry, size, dimension)
 * combination. Any cell below the floor is written as the literal token
 * "SUPPRESSED" so downstream tooling can detect and skip it.
 */
router.get(
  "/portfolio/benchmark.csv",
  requireAuth,
  async (req, res): Promise<void> => {
    const user = req.authedUser!;
    const [me] = await db
      .select({ role: usersTable.role })
      .from(usersTable)
      .where(eq(usersTable.id, user.id))
      .limit(1);
    const allowlist = (process.env["PULSE_ADMIN_EMAILS"] ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const isPulseAdmin =
      allowlist.length > 0
        ? allowlist.includes(user.email.toLowerCase())
        : false;
    if (me?.role !== "admin" && !isPulseAdmin) {
      res.status(403).json({ error: "Admin role required" });
      return;
    }

    // Optional createdAt window filter is honored even on the global
    // export so leadership can pull benchmarks for "last quarter" only.
    const filters = parseFilters(req.query as Record<string, unknown>);
    const whereClauses = [];
    if (filters.from) whereClauses.push(gte(engagementsTable.createdAt, filters.from));
    if (filters.to) whereClauses.push(lte(engagementsTable.createdAt, filters.to));
    const engagements = await (whereClauses.length > 0
      ? db
          .select()
          .from(engagementsTable)
          .where(and(...whereClauses))
      : db.select().from(engagementsTable));
    const engIds = engagements.map((e) => e.id);
    const scorings = engIds.length
      ? await db
          .select()
          .from(scoringTable)
          .where(inArray(scoringTable.engagementId, engIds))
      : [];

    const { csv, emittedCells, suppressedCells } = buildBenchmarkCsv(
      engagements,
      scorings,
      ANONYMITY_FLOOR,
    );

    // Audit the export so a compliance reviewer can see who pulled the
    // benchmark and which window they used. The download is the sensitive
    // action — log before sending. Engagement-scoped activity table
    // requires an engagementId, so we pick the most recent in scope (or
    // skip if there is literally nothing to attribute to).
    if (engagements.length > 0) {
      const latest = engagements
        .slice()
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
      await recordActivity(req, {
        engagementId: latest.id,
        kind: "portfolio_benchmark_exported",
        severity: "critical",
        message: `Portfolio benchmark CSV exported (${emittedCells} cells, ${suppressedCells} suppressed)`,
        payload: {
          engagementCount: engagements.length,
          emittedCells,
          suppressedCells,
          anonymityFloor: ANONYMITY_FLOOR,
          filters: {
            from: filters.from?.toISOString() ?? null,
            to: filters.to?.toISOString() ?? null,
          },
        },
      });
    }

    res
      .status(200)
      .setHeader("content-type", "text/csv; charset=utf-8")
      .setHeader(
        "content-disposition",
        `attachment; filename="pulse-benchmark.csv"`,
      )
      .send(csv);
  },
);

/**
 * Truncate a JS Date to the first day of its UTC month.
 */
function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/**
 * Format a Date as a YYYY-MM string (UTC).
 */
function formatMonth(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Parse a YYYY-MM query string into the first day of that month (UTC).
 * Returns null when the input is missing or malformed so callers can fall
 * back to the default (current month / N months ago).
 */
function parseMonth(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  if (month < 1 || month > 12) return null;
  return new Date(Date.UTC(year, month - 1, 1));
}

/**
 * Generate one Date per month from `from` to `to` inclusive.
 */
function monthsBetween(from: Date, to: Date): Date[] {
  const out: Date[] = [];
  let cursor = monthStart(from);
  const end = monthStart(to);
  // Cap range to a sensible upper bound to avoid pathological queries.
  let safety = 60;
  while (cursor <= end && safety-- > 0) {
    out.push(cursor);
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return out;
}

interface BinResult {
  byStage: Map<number, { id: string; name: string; teamCount: number }[]>;
  notYetAssessed: { id: string; name: string; teamCount: number }[];
  total: number;
}

/**
 * For a given month and the caller's filtered engagement set, find each
 * engagement's most recent snapshot whose `snapshotMonth <= monthEnd` and
 * bin them by overall stage. Engagements with no snapshot at or before
 * the month land in `notYetAssessed`. The "carry-forward" semantic keeps
 * the snapshot bar populated in months without recomputes.
 */
function binEngagementsAtMonth(
  engagements: Array<{ id: string; clientName: string; teamCount: number }>,
  snapshots: Array<{
    engagementId: string;
    snapshotMonth: Date;
    overallStage: number;
  }>,
  month: Date,
): BinResult {
  // Pick the latest snapshot per engagement at or before the requested
  // month. Sorting once and walking is O(N log N + M) — fine for portfolio
  // sizes (typically <100 engagements / <1k snapshots).
  const sortedByEng = new Map<string, typeof snapshots>();
  for (const s of snapshots) {
    if (s.snapshotMonth > month) continue;
    const arr = sortedByEng.get(s.engagementId) ?? [];
    arr.push(s);
    sortedByEng.set(s.engagementId, arr);
  }
  const byStage = new Map<
    number,
    { id: string; name: string; teamCount: number }[]
  >();
  for (let i = 1; i <= 5; i++) byStage.set(i, []);
  const notYetAssessed: { id: string; name: string; teamCount: number }[] = [];
  let total = 0;
  for (const eng of engagements) {
    const list = sortedByEng.get(eng.id);
    if (!list || list.length === 0) {
      notYetAssessed.push({
        id: eng.id,
        name: eng.clientName,
        teamCount: eng.teamCount,
      });
      continue;
    }
    list.sort((a, b) => +b.snapshotMonth - +a.snapshotMonth);
    const latest = list[0];
    const stage = Math.max(1, Math.min(5, Math.round(latest.overallStage)));
    byStage.get(stage)!.push({
      id: eng.id,
      name: eng.clientName,
      teamCount: eng.teamCount,
    });
    total += 1;
  }
  // Sort each stage column from largest team to smallest so the snapshot
  // bar's top-N display surfaces the most consequential engagements first.
  for (const list of byStage.values()) {
    list.sort((a, b) => b.teamCount - a.teamCount || a.name.localeCompare(b.name));
  }
  return { byStage, notYetAssessed, total };
}

router.get(
  "/portfolio/distribution",
  requireAuth,
  async (req, res): Promise<void> => {
    const user = req.authedUser!;
    const ids = await membershipIds(user.id, user.email);
    const month = parseMonth(req.query.month) ?? monthStart(new Date());
    const generatedAt = new Date().toISOString();
    if (ids.length === 0) {
      res.json({
        month: formatMonth(month),
        total: 0,
        byStage: emptyByStage(),
        notYetAssessed: [],
        generatedAt,
      });
      return;
    }
    const filters = parseDistributionFilters(req.query as Record<string, unknown>);
    const allEng = await db
      .select()
      .from(engagementsTable)
      .where(inArray(engagementsTable.id, ids));
    const filtered = applyFilters(allEng, filters);
    const filteredIds = filtered.map((e) => e.id);
    const snapshots = filteredIds.length
      ? await db
          .select({
            engagementId: engagementScoringSnapshotsTable.engagementId,
            snapshotMonth: engagementScoringSnapshotsTable.snapshotMonth,
            overallStage: engagementScoringSnapshotsTable.overallStage,
          })
          .from(engagementScoringSnapshotsTable)
          .where(
            inArray(
              engagementScoringSnapshotsTable.engagementId,
              filteredIds,
            ),
          )
      : [];
    const result = binEngagementsAtMonth(filtered, snapshots, month);
    const byStage = [1, 2, 3, 4, 5].map((stage) => {
      const list = result.byStage.get(stage)!;
      return {
        stage,
        label: STAGE_LABELS[stage] ?? `Stage ${stage}`,
        count: list.length,
        percent: result.total > 0 ? list.length / result.total : 0,
        engagements: list.map((e) => ({
          id: e.id,
          clientName: e.name,
          teamCount: e.teamCount,
        })),
      };
    });
    res.json({
      month: formatMonth(month),
      total: result.total,
      byStage,
      notYetAssessed: result.notYetAssessed.map((e) => ({
        id: e.id,
        clientName: e.name,
        teamCount: e.teamCount,
      })),
      generatedAt,
    });
  },
);

function emptyByStage() {
  return [1, 2, 3, 4, 5].map((stage) => ({
    stage,
    label: STAGE_LABELS[stage] ?? `Stage ${stage}`,
    count: 0,
    percent: 0,
    engagements: [],
  }));
}

router.get(
  "/portfolio/distribution/history",
  requireAuth,
  async (req, res): Promise<void> => {
    const user = req.authedUser!;
    const ids = await membershipIds(user.id, user.email);
    const generatedAt = new Date().toISOString();
    const now = monthStart(new Date());
    const defaultFrom = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1),
    );
    let from = parseMonth(req.query.from) ?? defaultFrom;
    let to = parseMonth(req.query.to) ?? now;
    if (from > to) {
      // Swap rather than 400 — the UI's playhead can't get into this state
      // through normal use, but a hand-typed URL could.
      [from, to] = [to, from];
    }
    if (ids.length === 0) {
      res.json({
        from: formatMonth(from),
        to: formatMonth(to),
        months: monthsBetween(from, to).map((m) => ({
          month: formatMonth(m),
          total: 0,
          byStage: [1, 2, 3, 4, 5].map((stage) => ({
            stage,
            count: 0,
            percent: 0,
          })),
        })),
        generatedAt,
      });
      return;
    }
    // Use the cohort-only parser so the history-window `from`/`to` query
    // params are NOT also interpreted as engagement createdAt filters.
    const filters = parseDistributionFilters(req.query as Record<string, unknown>);
    const allEng = await db
      .select()
      .from(engagementsTable)
      .where(inArray(engagementsTable.id, ids));
    const filtered = applyFilters(allEng, filters);
    const filteredIds = filtered.map((e) => e.id);
    // Pull every snapshot up to `to` for in-scope engagements; we need
    // earlier snapshots too so the carry-forward at the start of the
    // window finds an anchor.
    const snapshots = filteredIds.length
      ? await db
          .select({
            engagementId: engagementScoringSnapshotsTable.engagementId,
            snapshotMonth: engagementScoringSnapshotsTable.snapshotMonth,
            overallStage: engagementScoringSnapshotsTable.overallStage,
          })
          .from(engagementScoringSnapshotsTable)
          .where(
            and(
              inArray(
                engagementScoringSnapshotsTable.engagementId,
                filteredIds,
              ),
              lte(engagementScoringSnapshotsTable.snapshotMonth, to),
            ),
          )
      : [];
    const months = monthsBetween(from, to).map((m) => {
      const r = binEngagementsAtMonth(filtered, snapshots, m);
      return {
        month: formatMonth(m),
        total: r.total,
        byStage: [1, 2, 3, 4, 5].map((stage) => {
          const list = r.byStage.get(stage)!;
          return {
            stage,
            count: list.length,
            percent: r.total > 0 ? list.length / r.total : 0,
          };
        }),
      };
    });
    res.json({
      from: formatMonth(from),
      to: formatMonth(to),
      months,
      generatedAt,
    });
  },
);

// Touch sql import so tree-shake / lint don't drop it (kept for future
// SQL-side aggregations as the dataset grows past in-memory rollup).
void sql;

export default router;
