import { eq } from "drizzle-orm";
import { db, deliverablesTable } from "@workspace/db";

const ENGAGEMENT_ID = "07eafd3f-4706-494c-bfe7-b024e5659a82";

// Per-dimension assessor notes for the Acme demo heatmap. These are
// written into deliverables.heatmap[i].notes, alongside the existing
// currentStage / targetStage / confidence fields produced by the
// scoring + draft-deliverables flow. Phrasing is intentionally
// concrete (named systems, squads, owners) so the demo reads like a
// real engagement rather than placeholder copy.
//
// MUST match DIMENSIONS in artifacts/api-server/src/lib/rubric.ts
// (tooling, measurement, process, people, governance, culture).
const NOTES: Record<string, string> = {
  tooling:
    "Current (Stage 3 — AI-Enabled): Platform team ships a shared LLM gateway with auth, logging, and budget caps; two squads use a common eval harness on top. Target (Stage 4 — AI-Native): consolidate the prompt registry and guardrail library into a single internal SDK so every new agent inherits eval, tracing, and rollback for free.",
  measurement:
    "Current (Stage 3): Per-pilot dashboards exist (latency, deflection, CSAT) but each squad defines 'quality' differently. Target (Stage 4): a portfolio-level scorecard with shared metrics — task success, cost-per-resolved-task, human-override rate — so leadership can compare programs and reallocate budget.",
  process:
    "Current (Stage 3): Support and Ops squads run weekly eval reviews with a written change log on prompts; the rest still ship on gut feel. Target (Stage 4): every agent change goes through an offline eval gate + canary in CI before reaching production, owned by the squad rather than the platform team.",
  people:
    "Current (Stage 3): ~30 engineers have shipped at least one production agent; a small applied-AI guild meets biweekly. Target (Stage 4): a funded enablement track (curriculum + paid time) for all ICs, plus two senior applied-AI hires to seed the highest-leverage squads (Underwriting, Claims).",
  governance:
    "Current (Stage 2 — AI-Assisted): Approved-models list and a draft data-classification policy exist, but enforcement is manual and audit trails are inconsistent across squads. Target (Stage 3): policy-as-code in the LLM gateway — model allow-list, PII redaction, and immutable per-call audit log — so external review is a query, not a fire drill.",
  culture:
    "Current (Stage 2): Genuine exec sponsorship and curious teams, but the internal narrative is still 'AI as a productivity tool' rather than a business-model bet. Target (Stage 3): one named, board-visible bet (claims automation) with a public OKR and a willingness to retire a legacy revenue line if the agent wins.",
};

async function main() {
  const existing = await db
    .select({ heatmap: deliverablesTable.heatmap })
    .from(deliverablesTable)
    .where(eq(deliverablesTable.engagementId, ENGAGEMENT_ID))
    .limit(1);

  if (existing.length === 0) {
    console.error(
      `No deliverables row found for engagement ${ENGAGEMENT_ID}. ` +
        `Make sure the Acme engagement exists and has been through the ` +
        `scoring + draft-deliverables flow before seeding heatmap notes.`,
    );
    process.exit(1);
  }

  const heatmap = existing[0].heatmap as Array<{
    dimension: string;
    currentStage: number;
    targetStage: number;
    confidence: "low" | "medium" | "high";
    notes?: string;
  }>;

  if (!Array.isArray(heatmap) || heatmap.length === 0) {
    console.error(
      `Heatmap for engagement ${ENGAGEMENT_ID} is empty. Run the ` +
        `draft-deliverables endpoint first so the per-dimension cells ` +
        `exist, then re-run this seed.`,
    );
    process.exit(1);
  }

  const updated = heatmap.map((cell) => {
    const note = NOTES[cell.dimension];
    if (!note) {
      console.warn(
        `! no seed note defined for dimension "${cell.dimension}" — leaving as-is`,
      );
      return cell;
    }
    return { ...cell, notes: note };
  });

  await db
    .update(deliverablesTable)
    .set({ heatmap: updated })
    .where(eq(deliverablesTable.engagementId, ENGAGEMENT_ID));

  for (const cell of updated) {
    if (NOTES[cell.dimension]) console.log(`✓ ${cell.dimension}`);
  }
  console.log(
    `\nSeeded heatmap notes for ${
      updated.filter((c) => NOTES[c.dimension]).length
    } dimensions on engagement ${ENGAGEMENT_ID}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
