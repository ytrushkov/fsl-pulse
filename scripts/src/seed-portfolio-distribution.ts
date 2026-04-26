import { eq, and } from "drizzle-orm";
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

interface SeedEngagement {
  id: string;
  clientName: string;
  sponsor: string;
  industry: string;
  teamCount: number;
  startStage: number;
  endStage: number;
  monthlyDrift: number;
}

const SEED_ENGAGEMENTS: SeedEngagement[] = [
  {
    id: "d1a00001-0000-4000-8000-000000000001",
    clientName: "Demo · Northwind Bank",
    sponsor: "VP Engineering",
    industry: "fintech",
    teamCount: 28,
    startStage: 1,
    endStage: 3,
    monthlyDrift: 0.18,
  },
  {
    id: "d1a00001-0000-4000-8000-000000000002",
    clientName: "Demo · Helios Health",
    sponsor: "Chief Digital Officer",
    industry: "healthcare",
    teamCount: 14,
    startStage: 2,
    endStage: 4,
    monthlyDrift: 0.16,
  },
  {
    id: "d1a00001-0000-4000-8000-000000000003",
    clientName: "Demo · Coastline Retail",
    sponsor: "Head of Platform",
    industry: "retail",
    teamCount: 6,
    startStage: 1,
    endStage: 2,
    monthlyDrift: 0.08,
  },
  {
    id: "d1a00001-0000-4000-8000-000000000004",
    clientName: "Demo · Atlas Logistics",
    sponsor: "CTO",
    industry: "logistics",
    teamCount: 22,
    startStage: 2,
    endStage: 3,
    monthlyDrift: 0.1,
  },
  {
    id: "d1a00001-0000-4000-8000-000000000005",
    clientName: "Demo · Bluepeak SaaS",
    sponsor: "VP Product Engineering",
    industry: "software",
    teamCount: 18,
    startStage: 3,
    endStage: 5,
    monthlyDrift: 0.18,
  },
  {
    id: "d1a00001-0000-4000-8000-000000000006",
    clientName: "Demo · Meridian Energy",
    sponsor: "SVP Technology",
    industry: "energy",
    teamCount: 35,
    startStage: 1,
    endStage: 2,
    monthlyDrift: 0.07,
  },
  {
    id: "d1a00001-0000-4000-8000-000000000007",
    clientName: "Demo · Polaris Insurance",
    sponsor: "Head of Engineering",
    industry: "insurance",
    teamCount: 4,
    startStage: 2,
    endStage: 3,
    monthlyDrift: 0.1,
  },
];

const HORIZON_MONTHS = 12;

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

async function upsertEngagement(eng: SeedEngagement) {
  const existing = await db
    .select({ id: engagementsTable.id })
    .from(engagementsTable)
    .where(eq(engagementsTable.id, eng.id))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(engagementsTable).values({
      id: eng.id,
      clientName: eng.clientName,
      sponsor: eng.sponsor,
      industry: eng.industry,
      teamCount: eng.teamCount,
      scope: "Demo seed for Portfolio distribution snapshot",
      status: "active",
    });
    console.log(`+ engagement ${eng.clientName}`);
  } else {
    await db
      .update(engagementsTable)
      .set({
        clientName: eng.clientName,
        sponsor: eng.sponsor,
        industry: eng.industry,
        teamCount: eng.teamCount,
        status: "active",
      })
      .where(eq(engagementsTable.id, eng.id));
    console.log(`= engagement ${eng.clientName}`);
  }
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
  // Generate HORIZON_MONTHS rows ending at the current UTC month, with stages
  // drifting from startStage → endStage along a noisy linear path so the
  // 100% stacked-area trend reads as gradual rightward (more-mature) movement.
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
    const offsetFromOldest = i; // 0 = oldest, HORIZON_MONTHS-1 = current
    const monthsBack = HORIZON_MONTHS - 1 - offsetFromOldest;
    const month = monthBucket(baseYear, baseMonth - monthsBack);

    const span = HORIZON_MONTHS - 1;
    const t = span <= 0 ? 1 : offsetFromOldest / span;
    const idealScore =
      eng.startStage + (eng.endStage - eng.startStage) * t;

    // Per-engagement, per-month deterministic seed.
    const seedBase =
      Math.floor(month.getTime() / 86_400_000) +
      eng.id
        .split("-")
        .join("")
        .slice(0, 8)
        .split("")
        .reduce((a, c) => a + c.charCodeAt(0), 0);

    const overallScore = clampScore(idealScore + jitter(seedBase, eng.monthlyDrift));
    const overallStage = clampStage(overallScore);

    const byDimensionStages: Record<string, number> = {};
    const byDimensionScores: Record<string, number> = {};
    DIMENSIONS.forEach((dim, dIdx) => {
      const dimSeed = seedBase * 31 + dIdx * 7;
      const dimScore = clampScore(idealScore + jitter(dimSeed, eng.monthlyDrift * 1.6));
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
      latest = { overallScore, overallStage, byDimensionScores, byDimensionStages };
    }
  }

  return latest;
}

async function upsertScoring(eng: SeedEngagement, latest: LatestSnapshot) {
  // Mirror the latest snapshot into `scoring` so the engagements table at the
  // bottom of the Portfolio page shows the current overall stage badge for
  // each demo engagement (instead of "Not yet assessed").
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
  console.log(`Seeding portfolio distribution demo data`);
  console.log(`  member email: ${DEMO_EMAIL}`);
  console.log(`  engagements:  ${SEED_ENGAGEMENTS.length}`);
  console.log(`  months/each:  ${HORIZON_MONTHS}\n`);

  for (const eng of SEED_ENGAGEMENTS) {
    await upsertEngagement(eng);
    await ensureMember(eng.id, DEMO_EMAIL);
    const latest = await seedSnapshots(eng);
    await upsertScoring(eng, latest);
    console.log(
      `  ↳ ${HORIZON_MONTHS} monthly snapshots written; scoring set to stage ${latest.overallStage}`,
    );
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
