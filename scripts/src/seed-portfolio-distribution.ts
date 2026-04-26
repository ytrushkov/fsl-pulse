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

// Trajectory recipe — each row says "this many engagements move from
// `startStage` at the oldest month in the trend strip to `endStage` at the
// current month". Counts are tuned so the **current-month** distribution
// across all 199 demo engagements (plus the 1 real Acme engagement at
// stage 3) is exactly:
//   Stage 1: 31%   (62/200)
//   Stage 2: 52%   (104/200)
//   Stage 3: 14%   (27 demo + 1 Acme = 28/200)
//   Stage 4: 2.5%  (5/200)
//   Stage 5: 0.5%  (1/200)
// The earliest month is intentionally heavy on stages 1–2 so the trend
// strip reads as "we're slowly moving the book up", not as if everyone is
// already mature.
const TRAJECTORIES: Array<{
  count: number;
  startStage: number;
  endStage: number;
}> = [
  { count: 62, startStage: 1, endStage: 1 },
  { count: 60, startStage: 1, endStage: 2 },
  { count: 24, startStage: 1, endStage: 3 },
  { count: 44, startStage: 2, endStage: 2 },
  { count: 5, startStage: 2, endStage: 4 },
  { count: 3, startStage: 3, endStage: 3 },
  { count: 1, startStage: 3, endStage: 5 },
];

const HORIZON_MONTHS = 12;
// Per-month deterministic noise amplitude. Kept below 0.5 so it never
// pushes a snapshot across an integer stage boundary at the *endpoints*
// (where idealScore == startStage / endStage), which would corrupt the
// target current-month distribution.
const JITTER = 0.18;

interface SeedEngagement {
  id: string;
  clientName: string;
  sponsor: string;
  industry: string;
  teamCount: number;
  startStage: number;
  endStage: number;
}

function pad(n: number, width: number): string {
  return n.toString().padStart(width, "0");
}

function buildEngagement(
  index: number,
  startStage: number,
  endStage: number,
): SeedEngagement {
  const industry = INDUSTRIES[index % INDUSTRIES.length];
  const industryLabel = industry.charAt(0).toUpperCase() + industry.slice(1);
  return {
    id: `d1a00001-0000-4000-8000-${pad(index, 12)}`,
    clientName: `Demo · ${industryLabel} Co ${pad(index, 3)}`,
    sponsor: SPONSORS[index % SPONSORS.length],
    industry,
    teamCount: 4 + (index % 30),
    startStage,
    endStage,
  };
}

function expandTrajectories(): SeedEngagement[] {
  const engagements: SeedEngagement[] = [];
  let idx = 1;
  for (const t of TRAJECTORIES) {
    for (let i = 0; i < t.count; i++) {
      engagements.push(buildEngagement(idx, t.startStage, t.endStage));
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
  // Prior runs may have used a different TRAJECTORIES recipe; clearing all
  // engagements with the demo id prefix guarantees the new distribution
  // isn't polluted by leftover rows. FK cascades take care of members,
  // snapshots, scoring, narratives, etc.
  const result = await db.execute(
    sql`DELETE FROM engagements WHERE id::text LIKE 'd1a00001-%'`,
  );
  // `db.execute` returns a result object; `rowCount` is on the underlying
  // pg result.
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

  let latest: LatestSnapshot = {
    overallScore: eng.startStage,
    overallStage: clampStage(eng.startStage),
    byDimensionScores: {},
    byDimensionStages: {},
  };

  for (let i = 0; i < HORIZON_MONTHS; i++) {
    const offsetFromOldest = i;
    const monthsBack = HORIZON_MONTHS - 1 - offsetFromOldest;
    const month = monthBucket(baseYear, baseMonth - monthsBack);

    const span = HORIZON_MONTHS - 1;
    const t = span <= 0 ? 1 : offsetFromOldest / span;
    const idealScore =
      eng.startStage + (eng.endStage - eng.startStage) * t;

    const seedBase =
      Math.floor(month.getTime() / 86_400_000) +
      eng.id
        .split("-")
        .join("")
        .slice(0, 8)
        .split("")
        .reduce((a, c) => a + c.charCodeAt(0), 0);

    // At the endpoints (i=0 and i=HORIZON-1) we lock to startStage/endStage
    // exactly — that's how we guarantee the current-month aggregate matches
    // the headline percentages (31/52/14/2.5/0.5).
    const isEndpoint = i === 0 || i === HORIZON_MONTHS - 1;
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
  const engagements = expandTrajectories();
  console.log(`Seeding portfolio distribution demo data`);
  console.log(`  member email: ${DEMO_EMAIL}`);
  console.log(`  engagements:  ${engagements.length}`);
  console.log(`  months/each:  ${HORIZON_MONTHS}\n`);

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
