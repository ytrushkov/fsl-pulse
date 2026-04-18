import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import {
  db,
  artifactDocsTable,
  evidenceTable,
} from "@workspace/db";
import { paramId } from "../lib/util";
import { requireResourceMember } from "../middlewares/auth";
import { recordActivity } from "../lib/audit";

const router: IRouter = Router();

const requireArtifactMember = requireResourceMember({
  paramName: "artifactId",
  resolveEngagementId: async (id) => {
    const [row] = await db
      .select({ engagementId: artifactDocsTable.engagementId })
      .from(artifactDocsTable)
      .where(eq(artifactDocsTable.id, id))
      .limit(1);
    return row?.engagementId;
  },
});

function shape(a: typeof artifactDocsTable.$inferSelect) {
  return {
    id: a.id,
    engagementId: a.engagementId,
    filename: a.filename,
    kind: a.kind,
    sizeBytes: a.sizeBytes,
    extractedSummary: a.extractedSummary,
    createdAt: a.createdAt.toISOString(),
  };
}

router.get("/engagements/:id/artifacts", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const rows = await db
    .select()
    .from(artifactDocsTable)
    .where(eq(artifactDocsTable.engagementId, id))
    .orderBy(desc(artifactDocsTable.createdAt));
  res.json(rows.map(shape));
});

router.post("/engagements/:id/artifacts", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const b = req.body ?? {};
  if (!b.filename || !b.kind || typeof b.content !== "string") {
    res.status(400).json({ error: "filename, kind, content required" });
    return;
  }
  const summary = b.content.length > 280 ? b.content.slice(0, 277) + "..." : b.content;
  const [a] = await db
    .insert(artifactDocsTable)
    .values({
      engagementId: id,
      filename: b.filename,
      kind: b.kind,
      sizeBytes: Buffer.byteLength(b.content, "utf8"),
      content: b.content,
      extractedSummary: summary,
    })
    .returning();
  await recordActivity(req, {
    engagementId: id,
    kind: "artifact_uploaded",
    message: `Artifact uploaded: ${a.filename}`,
    payload: { artifactId: a.id, filename: a.filename, kind: a.kind, sizeBytes: a.sizeBytes },
  });
  res.status(201).json(shape(a));
});

router.delete("/artifacts/:artifactId", requireArtifactMember, async (req, res): Promise<void> => {
  const id = paramId(req.params.artifactId);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [doomed] = await db
    .select()
    .from(artifactDocsTable)
    .where(eq(artifactDocsTable.id, id))
    .limit(1);
  await db.delete(artifactDocsTable).where(eq(artifactDocsTable.id, id));
  if (doomed) {
    await recordActivity(req, {
      engagementId: doomed.engagementId,
      kind: "artifact_deleted",
      message: `Artifact deleted: ${doomed.filename}`,
      payload: { artifactId: doomed.id, filename: doomed.filename },
    });
  }
  res.sendStatus(204);
});

export default router;
