import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  deliverablesTable,
  scoringTable,
  evidenceTable,
} from "@workspace/db";
import { paramId } from "../lib/util";
import { draftDeliverablesAi } from "../lib/ai-deliverables";
import { recordActivity } from "../lib/audit";

const router: IRouter = Router();

function shape(d: typeof deliverablesTable.$inferSelect) {
  return {
    engagementId: d.engagementId,
    statuses: d.statuses,
    heatmap: d.heatmap,
    gapAnalysis: d.gapAnalysis,
    actionPlan: d.actionPlan,
    entryPoint: d.entryPoint,
    npv: d.npv,
  };
}

router.get("/engagements/:id/deliverables", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [d] = await db
    .select()
    .from(deliverablesTable)
    .where(eq(deliverablesTable.engagementId, id));
  if (!d) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(shape(d));
});

router.patch("/engagements/:id/deliverables", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const b = req.body ?? {};
  const [existing] = await db
    .select()
    .from(deliverablesTable)
    .where(eq(deliverablesTable.engagementId, id));
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const set: Record<string, unknown> = {};
  if (b.statuses)
    set.statuses = { ...(existing.statuses as Record<string, unknown>), ...b.statuses };
  if (b.heatmap) set.heatmap = b.heatmap;
  if (b.gapAnalysis) set.gapAnalysis = b.gapAnalysis;
  if (b.actionPlan) set.actionPlan = b.actionPlan;
  if (b.entryPoint) set.entryPoint = b.entryPoint;
  if (b.npv) set.npv = b.npv;
  const [d] = await db
    .update(deliverablesTable)
    .set(set)
    .where(eq(deliverablesTable.engagementId, id))
    .returning();
  // Activity attribution for deliverable edits. Finalize/lock transitions
  // are recorded as critical so they stand out in the audit timeline.
  const actor = req.authedUser!;
  const prevStatuses = (existing.statuses ?? {}) as Record<string, string>;
  const nextStatuses = (b.statuses ?? {}) as Record<string, string>;
  const finalized = Object.entries(nextStatuses)
    .filter(
      ([k, v]) =>
        (v === "locked" || v === "finalized") && prevStatuses[k] !== v,
    )
    .map(([k]) => k);
  if (finalized.length > 0) {
    for (const deliverable of finalized) {
      await recordActivity(req, {
        engagementId: id,
        kind: "deliverable_finalized",
        severity: "critical",
        message: `Finalized ${deliverable} by ${actor.name || actor.email}`,
        payload: {
          deliverable,
          previousStatus: prevStatuses[deliverable] ?? "draft",
          newStatus: nextStatuses[deliverable],
        },
      });
    }
  } else {
    await recordActivity(req, {
      engagementId: id,
      kind: "deliverable_updated",
      message: "Updated deliverables",
      payload: { changedFields: Object.keys(set) },
    });
  }
  res.json(shape(d));
});

router.post("/engagements/:id/deliverables/draft", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [scoring] = await db
    .select()
    .from(scoringTable)
    .where(eq(scoringTable.engagementId, id));
  if (!scoring) {
    res.status(400).json({ error: "Compute scoring before drafting deliverables" });
    return;
  }
  const evidence = await db
    .select()
    .from(evidenceTable)
    .where(eq(evidenceTable.engagementId, id));
  const [existing] = await db
    .select()
    .from(deliverablesTable)
    .where(eq(deliverablesTable.engagementId, id));
  const drafted = await draftDeliverablesAi({
    scoring: {
      byDimension: scoring.byDimension as Array<{
        dimension: string;
        score: number;
        stage: number;
        confidence: string;
        evidenceIds: string[];
        rationale: string;
      }>,
      overall: scoring.overall as { score: number; stage: number; confidence: string },
    },
    evidence: evidence.map((e) => ({
      id: e.id,
      dimension: e.dimension,
      signalType: e.signalType,
      stageHint: e.stageHint,
      text: e.text,
    })),
    previousNpv: (existing?.npv as Record<string, unknown> | null) ?? null,
  });
  const [d] = await db
    .update(deliverablesTable)
    .set({
      heatmap: drafted.heatmap,
      gapAnalysis: drafted.gapAnalysis,
      actionPlan: drafted.actionPlan,
      entryPoint: drafted.entryPoint,
      npv: drafted.npv,
    })
    .where(eq(deliverablesTable.engagementId, id))
    .returning();
  await recordActivity(req, {
    engagementId: id,
    kind: "deliverables_drafted",
    message: "Deliverables drafted with AI assistance",
    payload: {
      heatmapRows: Array.isArray(drafted.heatmap) ? drafted.heatmap.length : 0,
      gapRows: Array.isArray(drafted.gapAnalysis) ? drafted.gapAnalysis.length : 0,
      planRows: Array.isArray(drafted.actionPlan) ? drafted.actionPlan.length : 0,
    },
  });
  res.json(shape(d));
});

export default router;
