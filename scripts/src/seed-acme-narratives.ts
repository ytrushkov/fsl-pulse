import { and, eq, inArray, not } from "drizzle-orm";
import { db, scoringNarrativesTable } from "@workspace/db";

const ENGAGEMENT_ID = "07eafd3f-4706-494c-bfe7-b024e5659a82";

// MUST match DIMENSIONS in artifacts/api-server/src/lib/rubric.ts
// (tooling, measurement, process, people, governance, culture).
const NARRATIVES: Record<string, string> = {
  tooling:
    "Strong baseline platform (CICD, observability) is in place, but agent-specific tooling — eval harnesses, prompt registries, guardrails — is fragmented across squads.",
  measurement:
    "Pilot-level dashboards exist, but there is no shared definition of agent quality, cost-per-task, or business value to compare programs side by side.",
  process:
    "Two squads run disciplined eval loops; the rest still ship agents on gut feel. Change-management around prompts is informal and inconsistent.",
  people:
    "AI literacy varies widely. A few champions are pulling weight; broader IC enablement and an applied-AI hiring plan are still ad hoc.",
  governance:
    "Policy work is starting (data classification, approved-models list), but enforcement is manual and gaps in audit trails make external review hard.",
  culture:
    "Executive sponsorship is genuine and teams are curious, but framing is still 'AI as a tooling story' rather than a business-model bet, so risk-taking is uneven.",
};

async function main() {
  const valid = Object.keys(NARRATIVES);

  // Clean up any prior seed rows under invalid dimension names so we don't
  // leave orphaned narratives (the previous run used names like
  // "strategy"/"data" that don't exist in the rubric).
  const removed = await db
    .delete(scoringNarrativesTable)
    .where(
      and(
        eq(scoringNarrativesTable.engagementId, ENGAGEMENT_ID),
        not(inArray(scoringNarrativesTable.dimension, valid)),
      ),
    )
    .returning({ dimension: scoringNarrativesTable.dimension });
  if (removed.length) {
    console.log(`✗ removed ${removed.length} orphaned narratives:`, removed.map((r) => r.dimension).join(", "));
  }

  for (const [dimension, narrative] of Object.entries(NARRATIVES)) {
    await db
      .insert(scoringNarrativesTable)
      .values({
        engagementId: ENGAGEMENT_ID,
        dimension,
        narrative,
        updatedByName: "Seed (Acme demo)",
        updatedByEmail: "seed@pulse.local",
      })
      .onConflictDoUpdate({
        target: [
          scoringNarrativesTable.engagementId,
          scoringNarrativesTable.dimension,
        ],
        set: {
          narrative,
          updatedByName: "Seed (Acme demo)",
          updatedByEmail: "seed@pulse.local",
          updatedAt: new Date(),
        },
      });
    console.log(`✓ ${dimension}`);
  }
  console.log(`\nSeeded narratives for ${Object.keys(NARRATIVES).length} dimensions on engagement ${ENGAGEMENT_ID}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
