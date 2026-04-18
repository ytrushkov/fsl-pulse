import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import {
  db,
  exportsTable,
  engagementsTable,
  scoringTable,
  deliverablesTable,
  evidenceTable,
  surveyResponsesTable,
  interviewsTable,
  artifactDocsTable,
  connectorsTable,
  activityEventsTable,
} from "@workspace/db";
import {
  paramId,
  signExportPayload,
  verifyExportSignature,
  exportKeyFingerprint,
} from "../lib/util";

const router: IRouter = Router();

router.get("/engagements/:id/exports", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const rows = await db
    .select()
    .from(exportsTable)
    .where(eq(exportsTable.engagementId, id))
    .orderBy(desc(exportsTable.createdAt));
  res.json(
    rows.map((r) => ({
      id: r.id,
      engagementId: r.engagementId,
      version: r.version,
      createdAt: r.createdAt.toISOString(),
      signature: r.signature,
      files: r.files,
    })),
  );
});

router.post("/engagements/:id/exports", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [eng] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, id));
  if (!eng) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [scoring] = await db.select().from(scoringTable).where(eq(scoringTable.engagementId, id));
  const [deliverables] = await db
    .select()
    .from(deliverablesTable)
    .where(eq(deliverablesTable.engagementId, id));
  const evidence = await db.select().from(evidenceTable).where(eq(evidenceTable.engagementId, id));
  const responses = await db
    .select()
    .from(surveyResponsesTable)
    .where(eq(surveyResponsesTable.engagementId, id));
  const interviews = await db
    .select()
    .from(interviewsTable)
    .where(eq(interviewsTable.engagementId, id));
  const artifacts = await db
    .select()
    .from(artifactDocsTable)
    .where(eq(artifactDocsTable.engagementId, id));
  const connectors = await db
    .select()
    .from(connectorsTable)
    .where(eq(connectorsTable.engagementId, id));

  const bundle = {
    engagement: eng,
    scoring: scoring ?? null,
    deliverables: deliverables ?? null,
    evidence,
    surveyResponseCount: responses.length,
    interviewCount: interviews.length,
    artifactCount: artifacts.length,
    connectorCount: connectors.length,
    exportedAt: new Date().toISOString(),
  };
  const json = JSON.stringify(bundle, null, 2);
  // Keyed signature so recipients can detect tampering. The verification
  // endpoint is GET /exports/:exportId/verify (see route below) and the
  // public key fingerprint is `exportKeyFingerprint()`.
  const signature = signExportPayload(json);

  const previousCount = (
    await db.select().from(exportsTable).where(eq(exportsTable.engagementId, id))
  ).length;

  const files = [
    {
      name: "engagement-snapshot.json",
      sizeBytes: Buffer.byteLength(json, "utf8"),
      downloadUrl: `data:application/json;base64,${Buffer.from(json).toString("base64")}`,
    },
    {
      name: "heatmap.json",
      sizeBytes: Buffer.byteLength(JSON.stringify(deliverables?.heatmap ?? [])),
      downloadUrl: `data:application/json;base64,${Buffer.from(JSON.stringify(deliverables?.heatmap ?? [])).toString("base64")}`,
    },
    {
      name: "gap-analysis.json",
      sizeBytes: Buffer.byteLength(JSON.stringify(deliverables?.gapAnalysis ?? [])),
      downloadUrl: `data:application/json;base64,${Buffer.from(JSON.stringify(deliverables?.gapAnalysis ?? [])).toString("base64")}`,
    },
    {
      name: "action-plan.json",
      sizeBytes: Buffer.byteLength(JSON.stringify(deliverables?.actionPlan ?? [])),
      downloadUrl: `data:application/json;base64,${Buffer.from(JSON.stringify(deliverables?.actionPlan ?? [])).toString("base64")}`,
    },
    {
      name: "entry-point.json",
      sizeBytes: Buffer.byteLength(JSON.stringify(deliverables?.entryPoint ?? null)),
      downloadUrl: `data:application/json;base64,${Buffer.from(JSON.stringify(deliverables?.entryPoint ?? null)).toString("base64")}`,
    },
    {
      name: "npv.json",
      sizeBytes: Buffer.byteLength(JSON.stringify(deliverables?.npv ?? null)),
      downloadUrl: `data:application/json;base64,${Buffer.from(JSON.stringify(deliverables?.npv ?? null)).toString("base64")}`,
    },
  ];

  const [exp] = await db
    .insert(exportsTable)
    .values({
      engagementId: id,
      version: previousCount + 1,
      signature,
      files,
    })
    .returning();

  await db
    .update(engagementsTable)
    .set({ status: "exported" })
    .where(eq(engagementsTable.id, id));
  const actor = req.authedUser!;
  await db.insert(activityEventsTable).values({
    engagementId: id,
    actorUserId: actor.id,
    actorName: actor.name,
    actorEmail: actor.email,
    kind: "export_created",
    message: `Export v${exp.version} created`,
  });

  res.status(201).json({
    id: exp.id,
    engagementId: exp.engagementId,
    version: exp.version,
    createdAt: exp.createdAt.toISOString(),
    signature: exp.signature,
    signatureAlgorithm: "HMAC-SHA256",
    keyFingerprint: exportKeyFingerprint(),
    files: exp.files,
  });
});

// POST /engagements/:id/exports/:exportId/verify
//
// Recipients (or FullStack delivery leads) submit the snapshot bytes they
// were given as `{ snapshotJson }` and we re-compute the HMAC to confirm
// the bundle is untampered. The expected signature is read off the export
// record so the caller never needs to learn the signing key. The response
// is `{ ok, expectedAlgorithm: "HMAC-SHA256", keyFingerprint }`.
//
// Mounted under /engagements/:id/... so the global engagement-member guard
// in routes/index.ts applies — only members of the owning engagement may
// verify its exports. The handler also re-checks `exp.engagementId === id`
// to defeat URL tampering.
router.post(
  "/engagements/:id/exports/:exportId/verify",
  async (req, res): Promise<void> => {
    const id = paramId(req.params.id);
    const exportId = paramId(req.params.exportId);
    if (!id || !exportId) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [exp] = await db
      .select()
      .from(exportsTable)
      .where(eq(exportsTable.id, exportId));
    // Belt-and-suspenders: enforce that the export belongs to the engagement
    // in the URL, in addition to the member-of-engagement check that already
    // ran upstream.
    if (!exp || exp.engagementId !== id) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const submitted = (req.body?.snapshotJson ?? "") as string;
    if (typeof submitted !== "string" || submitted.length === 0) {
      res.status(400).json({ error: "snapshotJson required" });
      return;
    }
    const ok = verifyExportSignature(submitted, exp.signature);
    res.json({
      ok,
      expectedAlgorithm: "HMAC-SHA256",
      keyFingerprint: exportKeyFingerprint(),
    });
  },
);

export default router;
