import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import {
  db,
  scoringTable,
  scoreOverridesTable,
  scoringNarrativesTable,
} from "@workspace/db";
import { paramId } from "../lib/util";
import { computeEngagementScoring } from "../lib/scoring";
import { recordActivity } from "../lib/audit";
import { getRubricVersion } from "../lib/rubric-store";
import { requirePulseAdmin } from "../middlewares/auth";
import { DIMENSIONS } from "../lib/rubric";

const ALLOWED_DIMENSIONS = new Set<string>(DIMENSIONS);
const NARRATIVE_MAX_LENGTH = 280;

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
  // Always merge in narratives on read. The persisted `byDimension` JSON
  // could be stale (older rows pre-date the narrative feature, or the
  // assessor edited a narrative without re-running compute), and a
  // narrative is cheap enough to re-attach on every fetch.
  const narratives = await db
    .select()
    .from(scoringNarrativesTable)
    .where(eq(scoringNarrativesTable.engagementId, id));
  const byDim = new Map(narratives.map((n) => [n.dimension, n]));
  const enriched = (s.byDimension as Array<Record<string, unknown>>).map(
    (d) => {
      const n = byDim.get(d.dimension as string) ?? null;
      return {
        ...d,
        narrative: n?.narrative ?? null,
        narrativeUpdatedByName: n?.updatedByName ?? null,
        narrativeUpdatedByEmail: n?.updatedByEmail ?? null,
        narrativeUpdatedAt: n?.updatedAt.toISOString() ?? null,
      };
    },
  );
  res.json({
    engagementId: s.engagementId,
    rubricVersion: s.rubricVersion,
    rubricVersionId: s.rubricVersionId,
    byDimension: enriched,
    overall: s.overall,
    computedAt: s.computedAt.toISOString(),
  });
});

// Upsert the assessor's free-text narrative for a single dimension. Doesn't
// trigger a recompute — narrative is descriptive metadata that lives
// alongside scoring.byDimension and is merged on read.
router.put(
  "/engagements/:id/scoring/narrative",
  async (req, res): Promise<void> => {
    const id = paramId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const b = req.body ?? {};
    // Validate `narrative` strictly. Coercing missing/non-string to "" is
    // unsafe because it would silently take the delete branch on malformed
    // input — better to refuse the request and surface the bug to the caller.
    if (typeof b.narrative !== "string") {
      res.status(400).json({ error: "narrative must be a string" });
      return;
    }
    if (typeof b.dimension !== "string") {
      res.status(400).json({ error: "dimension required" });
      return;
    }
    const dimension = b.dimension.trim();
    if (!ALLOWED_DIMENSIONS.has(dimension)) {
      res
        .status(400)
        .json({ error: `dimension must be one of ${[...ALLOWED_DIMENSIONS].join(", ")}` });
      return;
    }
    const narrative = b.narrative.trim();
    if (narrative.length > NARRATIVE_MAX_LENGTH) {
      res
        .status(400)
        .json({ error: `narrative exceeds max length of ${NARRATIVE_MAX_LENGTH}` });
      return;
    }
    const actor = req.authedUser!;
    if (!narrative) {
      // Empty payload deletes the narrative — gives the UI a clean way to
      // reset back to "AI rationale only" without inventing a verb.
      await db
        .delete(scoringNarrativesTable)
        .where(
          and(
            eq(scoringNarrativesTable.engagementId, id),
            eq(scoringNarrativesTable.dimension, dimension),
          ),
        );
      await recordActivity(req, {
        engagementId: id,
        kind: "scoring_narrative_cleared",
        message: `Narrative cleared for ${dimension} by ${actor.name || actor.email}`,
        payload: { dimension },
      });
      res.json({ engagementId: id, dimension, narrative: null });
      return;
    }
    await db
      .insert(scoringNarrativesTable)
      .values({
        engagementId: id,
        dimension,
        narrative,
        updatedByUserId: actor.id,
        updatedByName: actor.name,
        updatedByEmail: actor.email,
      })
      .onConflictDoUpdate({
        target: [
          scoringNarrativesTable.engagementId,
          scoringNarrativesTable.dimension,
        ],
        set: {
          narrative,
          updatedByUserId: actor.id,
          updatedByName: actor.name,
          updatedByEmail: actor.email,
          updatedAt: new Date(),
        },
      });
    await recordActivity(req, {
      engagementId: id,
      kind: "scoring_narrative_saved",
      message: `Narrative updated for ${dimension} by ${actor.name || actor.email}`,
      payload: { dimension, length: narrative.length },
    });
    res.json({
      engagementId: id,
      dimension,
      narrative,
      narrativeUpdatedByName: actor.name,
      narrativeUpdatedByEmail: actor.email,
      narrativeUpdatedAt: new Date().toISOString(),
    });
  },
);

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
