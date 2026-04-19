import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import {
  db,
  scoringTable,
  scoreOverridesTable,
} from "@workspace/db";
import { paramId } from "../lib/util";
import { computeEngagementScoring } from "../lib/scoring";
import { recordActivity } from "../lib/audit";
import { getRubricVersion } from "../lib/rubric-store";
import { requirePulseAdmin } from "../middlewares/auth";

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
      rubricVersionId: null,
      byDimension: [],
      overall: { score: 0, stage: 0, confidence: "low" },
      computedAt: new Date().toISOString(),
    });
    return;
  }
  res.json({
    engagementId: s.engagementId,
    rubricVersion: s.rubricVersion,
    rubricVersionId: s.rubricVersionId,
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
  await recordActivity(req, {
    engagementId: id,
    kind: "scoring_computed",
    message: `Scoring computed (rubric ${result.rubricVersion})`,
    payload: {
      rubricVersion: result.rubricVersion,
      overall: result.overall,
    },
  });
  res.json(result);
});

/**
 * Preview an engagement's scoring against any rubric version (typically a
 * draft) without persisting. The frontend uses this to show "what would
 * scoring look like under draft v1.1?" before publishing the rubric.
 * The current persisted scoring is also returned so the UI can compute
 * deltas.
 */
router.post("/engagements/:id/scoring/preview", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const rubricVersionId =
    typeof req.body?.rubricVersionId === "string"
      ? req.body.rubricVersionId
      : null;
  if (!rubricVersionId) {
    res.status(400).json({ error: "rubricVersionId required" });
    return;
  }
  const rubric = await getRubricVersion(rubricVersionId);
  if (!rubric) {
    res.status(404).json({ error: "Rubric version not found" });
    return;
  }
  const preview = await computeEngagementScoring(id, {
    rubricVersionId,
    persist: false,
  });
  const [current] = await db
    .select()
    .from(scoringTable)
    .where(eq(scoringTable.engagementId, id));
  res.json({
    preview,
    current: current
      ? {
          engagementId: current.engagementId,
          rubricVersion: current.rubricVersion,
          rubricVersionId: current.rubricVersionId,
          byDimension: current.byDimension,
          overall: current.overall,
          computedAt: current.computedAt.toISOString(),
        }
      : null,
  });
});

/**
 * Recompute scoring under a newer published rubric and persist the result.
 * Drafts are refused — only a published version can be pinned.
 */
router.post("/engagements/:id/scoring/upgrade", requirePulseAdmin, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const rubricVersionId =
    typeof req.body?.rubricVersionId === "string"
      ? req.body.rubricVersionId
      : null;
  if (!rubricVersionId) {
    res.status(400).json({ error: "rubricVersionId required" });
    return;
  }
  const rubric = await getRubricVersion(rubricVersionId);
  if (!rubric) {
    res.status(404).json({ error: "Rubric version not found" });
    return;
  }
  if (rubric.status !== "published") {
    res.status(400).json({ error: "Only published rubrics can be pinned" });
    return;
  }
  const [previous] = await db
    .select()
    .from(scoringTable)
    .where(eq(scoringTable.engagementId, id));
  const result = await computeEngagementScoring(id, {
    rubricVersionId,
    persist: true,
  });
  await recordActivity(req, {
    engagementId: id,
    kind: "scoring_rubric_upgraded",
    severity: "critical",
    message: `Scoring upgraded to rubric ${rubric.version}`,
    payload: {
      from: previous
        ? { rubricVersion: previous.rubricVersion, overall: previous.overall }
        : null,
      to: { rubricVersion: result.rubricVersion, overall: result.overall },
    },
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
  // Snapshot the previous override (if any) for the same dimension so the
  // audit payload captures both before and after stages — useful for compliance
  // review when an assessor walks back a finalized score.
  const [previous] = await db
    .select()
    .from(scoreOverridesTable)
    .where(
      and(
        eq(scoreOverridesTable.engagementId, id),
        eq(scoreOverridesTable.dimension, b.dimension),
      ),
    )
    .orderBy(desc(scoreOverridesTable.createdAt))
    .limit(1);
  const actor = req.authedUser!;
  await db.insert(scoreOverridesTable).values({
    engagementId: id,
    dimension: b.dimension,
    stage: b.stage,
    score: b.score ?? null,
    justification: b.justification,
    actorUserId: actor.id,
    actorName: actor.name,
    actorEmail: actor.email,
  });
  const result = await computeEngagementScoring(id);
  await recordActivity(req, {
    engagementId: id,
    kind: "score_override",
    severity: "critical",
    message: `Override applied to ${b.dimension}: stage ${b.stage} by ${actor.name || actor.email}`,
    payload: {
      dimension: b.dimension,
      before: previous
        ? { stage: previous.stage, score: previous.score }
        : null,
      after: { stage: b.stage, score: b.score ?? null },
      justification: b.justification,
    },
  });
  res.json(result);
});

export default router;
