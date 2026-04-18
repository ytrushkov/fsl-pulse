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
} from "@workspace/db";
import {
  paramId,
  signExportPayload,
  verifyExportSignature,
  exportKeyFingerprint,
} from "../lib/util";
import { recordActivity } from "../lib/audit";
import {
  renderEngagementPdf,
  renderEngagementDocx,
  type DeliverableBundle,
} from "../lib/export-render";
import { and, eq as eqOp } from "drizzle-orm";
import { deliverableVersionsTable } from "@workspace/db";

const router: IRouter = Router();

const FINALIZABLE_KEYS = [
  "heatmap",
  "gapAnalysis",
  "actionPlan",
  "entryPoint",
  "npv",
] as const;

/**
 * Snapshot every versioned deliverable as a finalized version row and flip
 * its status to "locked". Used by the single Finalize-and-Export action so
 * the assessor doesn't have to lock each tab one by one before producing a
 * client bundle.
 */
async function finalizeAllDeliverables(
  engagementId: string,
  authorEmail: string | null,
): Promise<{ key: string; version: number }[]> {
  const [d] = await db
    .select()
    .from(deliverablesTable)
    .where(eq(deliverablesTable.engagementId, engagementId));
  if (!d) return [];
  const prevStatuses = (d.statuses ?? {}) as Record<string, string>;
  const finalized: { key: string; version: number }[] = [];
  const nextStatuses = { ...prevStatuses };
  for (const key of FINALIZABLE_KEYS) {
    if (prevStatuses[key] === "locked") continue;
    const snapshot = (d as Record<string, unknown>)[key];
    if (snapshot === null || snapshot === undefined) continue;
    const [latest] = await db
      .select({ version: deliverableVersionsTable.version })
      .from(deliverableVersionsTable)
      .where(
        and(
          eqOp(deliverableVersionsTable.engagementId, engagementId),
          eqOp(deliverableVersionsTable.deliverableKey, key),
        ),
      )
      .orderBy(desc(deliverableVersionsTable.version))
      .limit(1);
    const next = (latest?.version ?? 0) + 1;
    await db.insert(deliverableVersionsTable).values({
      engagementId,
      deliverableKey: key,
      version: next,
      snapshot: snapshot as object,
      authorEmail,
      finalized: true,
    });
    nextStatuses[key] = "locked";
    finalized.push({ key, version: next });
  }
  if (finalized.length > 0) {
    await db
      .update(deliverablesTable)
      .set({ statuses: nextStatuses })
      .where(eq(deliverablesTable.engagementId, engagementId));
  }
  return finalized;
}

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
      finalizerEmail: r.finalizerEmail,
      files: r.files,
    })),
  );
});

/**
 * Stream a single file out of an export record. Files are stored inline as
 * base64 data URLs (so the snapshot is portable and re-deliverable from a
 * cold backup); this endpoint decodes them and serves with the right
 * Content-Type so browsers download instead of rendering them as JSON.
 */
router.get(
  "/engagements/:id/exports/:exportId/file/:fileName",
  async (req, res): Promise<void> => {
    const id = paramId(req.params.id);
    const exportId = paramId(req.params.exportId);
    const fileName = String(req.params.fileName ?? "");
    if (!id || !exportId || !fileName) {
      res.status(400).json({ error: "Invalid params" });
      return;
    }
    const [exp] = await db
      .select()
      .from(exportsTable)
      .where(eq(exportsTable.id, exportId));
    if (!exp || exp.engagementId !== id) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    type ExportFile = { name: string; sizeBytes: number; downloadUrl: string };
    const file = (exp.files as ExportFile[]).find((f) => f.name === fileName);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    const m = /^data:([^;]+);base64,(.*)$/s.exec(file.downloadUrl);
    if (!m) {
      res.status(500).json({ error: "Malformed file" });
      return;
    }
    const buf = Buffer.from(m[2] ?? "", "base64");
    res.setHeader("Content-Type", m[1] ?? "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName.replace(/"/g, "")}"`,
    );
    res.setHeader("Content-Length", String(buf.length));
    res.end(buf);
  },
);

import type { Request } from "express";

type ExportResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; status: number; body: { error: string } };

async function buildAndPersistExport(req: Request, id: string): Promise<ExportResult> {
  const [eng] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, id));
  if (!eng) return { ok: false, status: 404, body: { error: "Not found" } };
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

  // Render the branded client deliverable in both PDF and DOCX so the
  // assessor can hand off whichever format the client prefers without
  // round-tripping back through the platform.
  const actor = req.authedUser ?? null;
  const bundleForRender: DeliverableBundle = {
    clientName: eng.clientName,
    sponsor: eng.sponsor,
    exportedAt: bundle.exportedAt,
    exportVersion: previousCount + 1,
    finalizerEmail: actor?.email ?? null,
    scoring: scoring
      ? {
          rubricVersion: scoring.rubricVersion,
          overall: scoring.overall as { score: number; stage: number; confidence: string },
          byDimension: scoring.byDimension as DeliverableBundle["scoring"] extends infer S
            ? S extends { byDimension: infer B }
              ? B
              : never
            : never,
        }
      : null,
    deliverables: {
      heatmap: (deliverables?.heatmap ?? []) as DeliverableBundle["deliverables"]["heatmap"],
      gapAnalysis: (deliverables?.gapAnalysis ?? []) as DeliverableBundle["deliverables"]["gapAnalysis"],
      actionPlan: (deliverables?.actionPlan ?? []) as DeliverableBundle["deliverables"]["actionPlan"],
      entryPoint: (deliverables?.entryPoint ?? null) as DeliverableBundle["deliverables"]["entryPoint"],
      npv: (deliverables?.npv ?? null) as DeliverableBundle["deliverables"]["npv"],
    },
  };
  const [pdfBuf, docxBuf] = await Promise.all([
    renderEngagementPdf(bundleForRender),
    renderEngagementDocx(bundleForRender),
  ]);
  const safeClient = eng.clientName.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
  const baseName = `${safeClient}-pulse-v${previousCount + 1}`;

  const files = [
    {
      name: `${baseName}.pdf`,
      sizeBytes: pdfBuf.length,
      downloadUrl: `data:application/pdf;base64,${pdfBuf.toString("base64")}`,
    },
    {
      name: `${baseName}.docx`,
      sizeBytes: docxBuf.length,
      downloadUrl: `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${docxBuf.toString("base64")}`,
    },
    {
      name: "engagement-snapshot.json",
      sizeBytes: Buffer.byteLength(json, "utf8"),
      downloadUrl: `data:application/json;base64,${Buffer.from(json).toString("base64")}`,
    },
  ];

  const [exp] = await db
    .insert(exportsTable)
    .values({
      engagementId: id,
      version: previousCount + 1,
      signature,
      files,
      finalizerEmail: actor?.email ?? null,
    })
    .returning();

  await db
    .update(engagementsTable)
    .set({ status: "exported" })
    .where(eq(engagementsTable.id, id));
  await recordActivity(req, {
    engagementId: id,
    kind: "export_created",
    severity: "critical",
    message: `Export v${exp.version} created`,
    payload: {
      exportId: exp.id,
      version: exp.version,
      keyFingerprint: exportKeyFingerprint(),
      bytes: Buffer.byteLength(json, "utf8"),
    },
  });

  return {
    ok: true,
    payload: {
      id: exp.id,
      engagementId: exp.engagementId,
      version: exp.version,
      createdAt: exp.createdAt.toISOString(),
      signature: exp.signature,
      signatureAlgorithm: "HMAC-SHA256",
      keyFingerprint: exportKeyFingerprint(),
      files: exp.files,
      finalizerEmail: exp.finalizerEmail,
    },
  };
}

router.post("/engagements/:id/exports", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const result = await buildAndPersistExport(req, id);
  if (!result.ok) {
    res.status(result.status).json(result.body);
    return;
  }
  res.status(201).json(result.payload);
});

/**
 * Single Finalize-and-Export action: snapshot every unlocked deliverable as
 * a finalized version, flip its status to "locked", then build the branded
 * PDF/DOCX/JSON bundle in one round-trip. This is the canonical
 * client-handoff action — assessors don't have to lock each tab one by one.
 */
router.post(
  "/engagements/:id/finalize-and-export",
  async (req, res): Promise<void> => {
    const id = paramId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const actor = req.authedUser ?? null;
    const finalized = await finalizeAllDeliverables(id, actor?.email ?? null);
    if (finalized.length > 0) {
      await recordActivity(req, {
        engagementId: id,
        kind: "deliverable_finalized",
        severity: "critical",
        message: `Finalized ${finalized.length} deliverable(s) for export`,
        payload: { finalized },
      });
    }
    const result = await buildAndPersistExport(req, id);
    if (!result.ok) {
      res.status(result.status).json(result.body);
      return;
    }
    // Contract: respond with the freshly-built ExportRecord exactly as
    // documented in OpenAPI (no extra `finalized` payload). The list of
    // newly-finalized keys is preserved in the audit log above for any
    // downstream observers that need the detail.
    res.status(201).json(result.payload);
  },
);

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
    await recordActivity(req, {
      engagementId: id,
      kind: ok ? "export_verified" : "export_verify_failed",
      severity: "critical",
      message: ok
        ? `Export v${exp.version} signature verified`
        : `Export v${exp.version} signature mismatch`,
      payload: { exportId: exp.id, version: exp.version, ok },
    });
    res.json({
      ok,
      expectedAlgorithm: "HMAC-SHA256",
      keyFingerprint: exportKeyFingerprint(),
    });
  },
);

export default router;
