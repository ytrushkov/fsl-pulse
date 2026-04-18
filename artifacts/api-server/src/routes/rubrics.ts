import { Router, type IRouter } from "express";
import {
  listRubricVersions,
  getRubricVersion,
  createDraftRubric,
  updateDraftRubric,
  publishDraftRubric,
  deleteDraftRubric,
  type RubricBody,
} from "../lib/rubric-store";
import { paramId } from "../lib/util";
import { db, activityEventsTable } from "@workspace/db";

const router: IRouter = Router();

function isRubricBody(b: unknown): b is RubricBody {
  if (!b || typeof b !== "object") return false;
  const dims = (b as { dimensions?: unknown }).dimensions;
  return Array.isArray(dims);
}

router.get("/rubrics", async (_req, res): Promise<void> => {
  const rows = await listRubricVersions();
  res.json(rows.map(toApi));
});

router.get("/rubrics/:id", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const row = await getRubricVersion(id);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(toApi(row));
});

router.post("/rubrics", async (req, res): Promise<void> => {
  const b = req.body ?? {};
  if (typeof b.version !== "string" || !b.version.trim()) {
    res.status(400).json({ error: "version (string) is required" });
    return;
  }
  if (b.body !== undefined && !isRubricBody(b.body)) {
    res.status(400).json({ error: "body.dimensions must be an array" });
    return;
  }
  const actor = req.authedUser;
  const row = await createDraftRubric({
    version: b.version.trim(),
    notes: typeof b.notes === "string" ? b.notes : "",
    body: b.body,
    cloneFromId: typeof b.cloneFromId === "string" ? b.cloneFromId : undefined,
    createdByEmail: actor?.email ?? null,
  });
  res.status(201).json(toApi(row));
});

router.patch("/rubrics/:id", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const b = req.body ?? {};
  if (b.body !== undefined && !isRubricBody(b.body)) {
    res.status(400).json({ error: "body.dimensions must be an array" });
    return;
  }
  try {
    const row = await updateDraftRubric(id, {
      version: typeof b.version === "string" ? b.version : undefined,
      notes: typeof b.notes === "string" ? b.notes : undefined,
      body: b.body,
    });
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(toApi(row));
  } catch (err) {
    res.status(409).json({
      error: err instanceof Error ? err.message : "Update failed",
    });
  }
});

router.post("/rubrics/:id/publish", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const row = await publishDraftRubric(id);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Publish events are practice-wide rather than engagement-scoped, but the
  // activity feed is engagement-scoped today. We log to a synthetic
  // engagement-less audit row by using a sentinel kind so a future portfolio
  // dashboard can surface them; for now this is a best-effort audit.
  try {
    await db.insert(activityEventsTable).values({
      engagementId: id, // re-use rubric id as scope so the row is queryable
      actorUserId: req.authedUser?.id ?? null,
      actorName: req.authedUser?.name ?? "system",
      actorEmail: req.authedUser?.email ?? null,
      kind: "rubric_published",
      severity: "critical",
      message: `Rubric ${row.version} published`,
      payload: { rubricVersionId: row.id, version: row.version },
    });
  } catch {
    // Audit logging is best-effort here because rubric scope isn't an
    // engagement; never let it block the publish.
  }
  res.json(toApi(row));
});

router.delete("/rubrics/:id", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  try {
    const ok = await deleteDraftRubric(id);
    if (!ok) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.sendStatus(204);
  } catch (err) {
    res.status(409).json({
      error: err instanceof Error ? err.message : "Delete failed",
    });
  }
});

function toApi(row: Awaited<ReturnType<typeof getRubricVersion>> & object) {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    body: row.body,
    notes: row.notes,
    createdByEmail: row.createdByEmail,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export default router;
