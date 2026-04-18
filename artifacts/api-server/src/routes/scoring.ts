import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  scoringTable,
  scoreOverridesTable,
  activityEventsTable,
} from "@workspace/db";
import { paramId } from "../lib/util";
import { computeEngagementScoring } from "../lib/scoring";

const router: IRouter = Router();

router.get("/engagements/:id/scoring", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [s] = await db.select().from(scoringTable).where(eq(scoringTable.engagementId, id));
  if (!s) {
    // Return an empty shell so frontend can render
    res.json({
      engagementId: id,
      rubricVersion: "1.0.0",
      byDimension: [],
      overall: { score: 0, stage: 0, confidence: "low" },
      computedAt: new Date().toISOString(),
    });
    return;
  }
  res.json({
    engagementId: s.engagementId,
    rubricVersion: s.rubricVersion,
    byDimension: s.byDimension,
    overall: s.overall,
    computedAt: s.computedAt.toISOString(),
  });
});

router.post("/engagements/:id/scoring", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const result = await computeEngagementScoring(id);
  const actor = req.authedUser!;
  await db.insert(activityEventsTable).values({
    engagementId: id,
    actorUserId: actor.id,
    actorName: actor.name,
    actorEmail: actor.email,
    kind: "scoring_computed",
    message: `Scoring computed (rubric ${result.rubricVersion})`,
  });
  res.json(result);
});

router.post("/engagements/:id/scoring/override", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const b = req.body ?? {};
  if (!b.dimension || typeof b.stage !== "number" || !b.justification) {
    res.status(400).json({ error: "dimension, stage, justification required" });
    return;
  }
  await db.insert(scoreOverridesTable).values({
    engagementId: id,
    dimension: b.dimension,
    stage: b.stage,
    score: b.score ?? null,
    justification: b.justification,
  });
  const result = await computeEngagementScoring(id);
  const actor = req.authedUser!;
  await db.insert(activityEventsTable).values({
    engagementId: id,
    actorUserId: actor.id,
    actorName: actor.name,
    actorEmail: actor.email,
    kind: "score_override",
    message: `Override applied to ${b.dimension}: stage ${b.stage} by ${actor.name || actor.email}`,
  });
  res.json(result);
});

export default router;
