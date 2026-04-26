import { eq, and, sql } from "drizzle-orm";
import {
  db,
  engagementsTable,
  engagementMembersTable,
  engagementScoringSnapshotsTable,
  scoringTable,
} from "@workspace/db";

const DIMENSIONS = [
  "tooling",
  "measurement",
  "process",
  "people",
  "governance",
  "culture",
] as const;

const DEMO_EMAIL =
  process.env.DEMO_USER_EMAIL?.trim() ||
  process.argv.find((a) => a.startsWith("--email="))?.split("=")[1] ||
  "demo@pulse.local";

// Industries / sponsor titles cycled to give the engagements table at the
// bottom of the Portfolio page some variety. They have no effect on the
// snapshot bar — only `overallStage` does.
const INDUSTRIES = [
  "fintech",
  "healthcare",
  "retail",
  "logistics",
  "software",
  "energy",
  "insurance",
  "manufacturing",
  "telecom",
  "media",
];

const SPONSORS = [
  "VP Engineering",
  "CTO",
  "Chief Digital Officer",
  "Head of Platform",
  "VP Product Engineering",
  "SVP Technology",
  "Head of Engineering",
  "Director of Data",
  "Chief Information Officer",
  "Head of Architecture",
];

// End-stage recipe: how many demo engagements should be at each stage in
// the *current* month (April 2026). With Acme — the one real engagement,
// pinned at stage 3 — added on top, the totals become:
//   Stage 1: 62           → 31%
//   Stage 2: 104          → 52%
//   Stage 3: 27 + Acme    → 14%
//   Stage 4: 5            → 2.5%
//   Stage 5: 1            → 0.5%
//                  total: 200
const END_STAGE_RECIPE: Array<{ count: number; endStage: number }> = [
  { count: 62, endStage: 1 },
  { count: 104, endStage: 2 },
  { count: 27, endStage: 3 },
  { count: 5, endStage: 4 },
  { count: 1, endStage: 5 },
];

// New-engagements-per-month vector. Index 0 = oldest month in the trend
// strip (May 2025 when run April 2026), index 11 = current month. Sums to
// 199 to match END_STAGE_RECIPE. Cumulative grows roughly linearly:
//   5, 23, 40, 58, 76, 93, 111, 129, 147, 165, 182, 199
// so the 100% stacked-area chart starts narrow on the left and widens to
// the full book on the right.
const COHORT_SIZES = [5, 18, 17, 18, 18, 17, 18, 18, 18, 18, 17, 17];

const HORIZON_MONTHS = COHORT_SIZES.length; // 12
// Per-month deterministic noise amplitude on the linearly-interpolated
// score path. Endpoints are locked to integer stage values so the
// current-month aggregate stays exact regardless of jitter.
const JITTER = 0.18;

interface SeedEngagement {
  id: string;
  clientName: string;
  sponsor: string;
  industry: string;
  teamCount: number;
  endStage: number;
  firstMonthIndex: number; // 0..HORIZON_MONTHS-1
}

function pad(n: number, width: number): string {
  return n.toString().padStart(width, "0");
}

/**
 * Climb amount from `startStage` to `endStage` based on how long the
 * engagement has been on the books. Newer engagements stay flat (we don't
 * have history to invent); older ones show modest upward movement.
 */
function startStageFor(endStage: number, monthsActive: number): number {
  if (monthsActive >= 10) return Math.max(1, endStage - 2);
  if (monthsActive >= 5) return Math.max(1, endStage - 1);
  return endStage;
}

function buildEngagement(
  index: number,
  endStage: number,
  firstMonthIndex: number,
): SeedEngagement {
  const industry = INDUSTRIES[index % INDUSTRIES.length];
  const industryLabel = industry.charAt(0).toUpperCase() + industry.slice(1);
  return {
    id: `d1a00001-0000-4000-8000-${pad(index, 12)}`,
    clientName: `Demo · ${industryLabel} Co ${pad(index, 3)}`,
    sponsor: SPONSORS[index % SPONSORS.length],
    industry,
    teamCount: 4 + (index % 30),
    endStage,
    firstMonthIndex,
  };
}

/** Deterministic 32-bit hash → float in [0,1). Used to seed the shuffle. */
function pseudoRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** Fisher–Yates with deterministic seed so reruns produce identical data. */
function deterministicShuffle<T>(items: T[], seed: number): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(pseudoRandom(seed + i) * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Expand the end-stage recipe into 199 concrete engagements, then
 * deterministically interleave so each cohort gets a proportional mix of
 * stages, then slice into per-month cohorts using COHORT_SIZES.
 */
function expandEngagements(): SeedEngagement[] {
  const endStages: number[] = [];
  for (const r of END_STAGE_RECIPE) {
    for (let i = 0; i < r.count; i++) endStages.push(r.endStage);
  }
  const totalNeeded = COHORT_SIZES.reduce((a, b) => a + b, 0);
  if (endStages.length !== totalNeeded) {
    throw new Error(
      `END_STAGE_RECIPE total (${endStages.length}) does not match COHORT_SIZES total (${totalNeeded})`,
    );
  }

  // Mix the end-stages so e.g. May 2025's 5 engagements aren't all stage 1.
  const shuffled = deterministicShuffle(endStages, 1729);

  const engagements: SeedEngagement[] = [];
  let cursor = 0;
  let idx = 1;
  for (let m = 0; m < COHORT_SIZES.length; m++) {
    const size = COHORT_SIZES[m];
    for (let i = 0; i < size; i++) {
      const endStage = shuffled[cursor++];
      engagements.push(buildEngagement(idx, endStage, m));
      idx++;
    }
  }
  return engagements;
}

function monthBucket(year: number, monthIndex: number): Date {
  return new Date(Date.UTC(year, monthIndex, 1));
}

/** Deterministic noise in [-amp, amp] so seeded data is stable across runs. */
function jitter(seed: number, amp: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return ((x - Math.floor(x)) * 2 - 1) * amp;
}

function clampStage(n: number): number {
  return Math.max(1, Math.min(5, Math.round(n)));
}

function clampScore(n: number): number {
  return Math.max(1, Math.min(5, Number(n.toFixed(2))));
}

async function wipePriorDemoSeed(): Promise<number> {
  const result = await db.execute(
    sql`DELETE FROM engagements WHERE id::text LIKE 'd1a00001-%'`,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const count = (result as any)?.rowCount ?? 0;
  return count;
}

async function insertEngagement(eng: SeedEngagement) {
  await db.insert(engagementsTable).values({
    id: eng.id,
    clientName: eng.clientName,
    sponsor: eng.sponsor,
    industry: eng.industry,
    teamCount: eng.teamCount,
    scope: "Demo seed for Portfolio distribution snapshot",
    status: "active",
  });
}

async function ensureMember(engagementId: string, email: string) {
  const existing = await db
    .select({ id: engagementMembersTable.id })
    .from(engagementMembersTable)
    .where(
      and(
        eq(engagementMembersTable.engagementId, engagementId),
        eq(engagementMembersTable.email, email),
      ),
    )
    .limit(1);
  if (existing.length === 0) {
    await db.insert(engagementMembersTable).values({
      engagementId,
      email,
      role: "owner",
    });
  }
}

interface LatestSnapshot {
  overallScore: number;
  overallStage: number;
  byDimensionScores: Record<string, number>;
  byDimensionStages: Record<string, number>;
}

async function seedSnapshots(eng: SeedEngagement): Promise<LatestSnapshot> {
  const now = new Date();
  const baseYear = now.getUTCFullYear();
  const baseMonth = now.getUTCMonth();

  // monthsActive includes both endpoints (firstMonthIndex .. current month).
  const monthsActive = HORIZON_MONTHS - eng.firstMonthIndex;
  const startStage = startStageFor(eng.endStage, monthsActive);

  let latest: LatestSnapshot = {
    overallScore: eng.endStage,
    overallStage: eng.endStage,
    byDimensionScores: {},
    byDimensionStages: {},
  };

  for (let i = eng.firstMonthIndex; i < HORIZON_MONTHS; i++) {
    const monthsBack = HORIZON_MONTHS - 1 - i;
    const month = monthBucket(baseYear, baseMonth - monthsBack);

    // Local progress through this engagement's own lifespan: 0 at
    // firstMonthIndex, 1 at the current month. For one-month-old
    // engagements (monthsActive == 1) we skip interpolation entirely.
    const localSpan = monthsActive - 1;
    const t = localSpan <= 0 ? 1 : (i - eng.firstMonthIndex) / localSpan;
    const idealScore = startStage + (eng.endStage - startStage) * t;

    const seedBase =
      Math.floor(month.getTime() / 86_400_000) +
      eng.id
        .split("-")
        .join("")
        .slice(0, 8)
        .split("")
        .reduce((a, c) => a + c.charCodeAt(0), 0);

    const isEndpoint = i === eng.firstMonthIndex || i === HORIZON_MONTHS - 1;
    const overallScoreRaw = isEndpoint
      ? idealScore
      : idealScore + jitter(seedBase, JITTER);
    const overallScore = clampScore(overallScoreRaw);
    const overallStage = clampStage(overallScore);

    const byDimensionStages: Record<string, number> = {};
    const byDimensionScores: Record<string, number> = {};
    DIMENSIONS.forEach((dim, dIdx) => {
      const dimSeed = seedBase * 31 + dIdx * 7;
      const dimScore = clampScore(idealScore + jitter(dimSeed, JITTER * 1.4));
      byDimensionStages[dim] = clampStage(dimScore);
      byDimensionScores[dim] = dimScore;
    });

    await db
      .insert(engagementScoringSnapshotsTable)
      .values({
        engagementId: eng.id,
        snapshotMonth: month,
        overallStage,
        overallScore,
        byDimensionStages,
      })
      .onConflictDoUpdate({
        target: [
          engagementScoringSnapshotsTable.engagementId,
          engagementScoringSnapshotsTable.snapshotMonth,
        ],
        set: {
          overallStage,
          overallScore,
          byDimensionStages,
          capturedAt: new Date(),
        },
      });

    if (i === HORIZON_MONTHS - 1) {
      latest = {
        overallScore,
        overallStage,
        byDimensionScores,
        byDimensionStages,
      };
    }
  }

  return latest;
}

async function upsertScoring(eng: SeedEngagement, latest: LatestSnapshot) {
  const byDimension = DIMENSIONS.map((dim) => ({
    dimension: dim,
    score: latest.byDimensionScores[dim] ?? latest.overallScore,
    stage: latest.byDimensionStages[dim] ?? latest.overallStage,
    confidence: "medium",
    evidenceIds: [],
    rationale: "Demo seed",
    signalsBySource: {},
  }));
  const overall = {
    score: latest.overallScore,
    stage: latest.overallStage,
    confidence: "medium",
  };

  const existing = await db
    .select({ engagementId: scoringTable.engagementId })
    .from(scoringTable)
    .where(eq(scoringTable.engagementId, eng.id))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(scoringTable).values({
      engagementId: eng.id,
      rubricVersion: "1.0.0",
      byDimension,
      overall,
      computedAt: new Date(),
    });
  } else {
    await db
      .update(scoringTable)
      .set({
        rubricVersion: "1.0.0",
        byDimension,
        overall,
        computedAt: new Date(),
      })
      .where(eq(scoringTable.engagementId, eng.id));
  }
}

async function main() {
  const engagements = expandEngagements();
  console.log(`Seeding portfolio distribution demo data`);
  console.log(`  member email: ${DEMO_EMAIL}`);
  console.log(`  engagements:  ${engagements.length}`);
  console.log(`  months/each:  ${HORIZON_MONTHS}`);
  console.log(`  cohort sizes: ${COHORT_SIZES.join(", ")}\n`);

  const wiped = await wipePriorDemoSeed();
  if (wiped > 0) {
    console.log(`- removed ${wiped} prior demo engagement(s)\n`);
  }

  let count = 0;
  for (const eng of engagements) {
    await insertEngagement(eng);
    await ensureMember(eng.id, DEMO_EMAIL);
    const latest = await seedSnapshots(eng);
    await upsertScoring(eng, latest);
    count++;
    if (count % 25 === 0 || count === engagements.length) {
      console.log(`  ${count}/${engagements.length} seeded`);
    }
  }

  console.log(
    `\nDone. Sign in as ${DEMO_EMAIL} (or run with DEMO_USER_EMAIL=you@example.com) to see them on /portfolio.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
