import { Router, type IRouter } from "express";
import { eq, and, desc, isNull, gt } from "drizzle-orm";
import {
  db,
  artifactDocsTable,
  artifactUploadIntentsTable,
} from "@workspace/db";
import { paramId } from "../lib/util";
import { requireResourceMember } from "../middlewares/auth";
import { recordActivity } from "../lib/audit";
import {
  DOCX_MIME,
  PPTX_MIME,
  extractDocxText,
  extractPptxText,
} from "../lib/document-extract";
import {
  ObjectStorageService,
  ObjectNotFoundError,
} from "../lib/objectStorage";

// MIME types we allow uploaders to declare. Anything else is coerced to
// `application/octet-stream` on serve so a malicious upload can't be
// rendered inline as HTML/JS in the app origin (stored XSS defence).
const ALLOWED_MIME = new Set<string>([
  "application/pdf",
  "text/plain",
  "text/markdown",
  DOCX_MIME,
  PPTX_MIME,
]);
// MIME types whose text we extract server-side (mammoth for docx, OOXML
// slide-text scrape for pptx). Listed separately because the client never
// pre-extracts these — it just hands us the raw binary which now lives in
// object storage by the time this handler runs.
const SERVER_EXTRACTABLE_MIME = new Set<string>([DOCX_MIME, PPTX_MIME]);
// Only these types are safe to render inline in the browser. Anything else
// (including PDFs that happen to declare an unknown subtype) is forced as
// an attachment download.
const INLINE_SAFE_MIME = new Set<string>([
  "application/pdf",
  "text/plain",
]);

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

// Presigned-URL TTL is 15 min in objectStorage.ts; keep the intent TTL the
// same so we never let a client register an objectKey whose presigned PUT
// has already expired.
const UPLOAD_INTENT_TTL_MS = 15 * 60 * 1000;
// Hard ceiling on a single artifact upload (server-enforced; the frontend
// caps at 100 MB but we don't trust the client). Without this, a logged-in
// user could request URLs for arbitrarily large objects and run up storage
// cost.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

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
    mimeType: a.mimeType,
    hasBinary: Boolean(a.objectKey && a.objectKey.length > 0),
    createdAt: a.createdAt.toISOString(),
  };
}

router.get("/engagements/:id/artifacts", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  // Project metadata columns only — we no longer need to special-case the
  // binary column since `object_key` is just a short string, but we still
  // skip `content` to keep the list payload small.
  const rows = await db
    .select({
      id: artifactDocsTable.id,
      engagementId: artifactDocsTable.engagementId,
      filename: artifactDocsTable.filename,
      kind: artifactDocsTable.kind,
      sizeBytes: artifactDocsTable.sizeBytes,
      extractedSummary: artifactDocsTable.extractedSummary,
      mimeType: artifactDocsTable.mimeType,
      objectKey: artifactDocsTable.objectKey,
      createdAt: artifactDocsTable.createdAt,
    })
    .from(artifactDocsTable)
    .where(eq(artifactDocsTable.engagementId, id))
    .orderBy(desc(artifactDocsTable.createdAt));
  res.json(
    rows.map((r) => ({
      id: r.id,
      engagementId: r.engagementId,
      filename: r.filename,
      kind: r.kind,
      sizeBytes: r.sizeBytes,
      extractedSummary: r.extractedSummary,
      mimeType: r.mimeType,
      hasBinary: Boolean(r.objectKey && r.objectKey.length > 0),
      createdAt: r.createdAt.toISOString(),
    })),
  );
});

// Issue a presigned upload URL scoped to this engagement and the calling
// user. Path is intentionally nested under `/engagements/:id/...` so the
// existing engagement-membership wrapper gates it; any newly issued
// objectKey is recorded as an upload intent and must be consumed by a
// matching POST /engagements/:id/artifacts before it can ever be served.
router.post(
  "/engagements/:id/storage/uploads/request-url",
  async (req, res): Promise<void> => {
    const id = paramId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const user = req.authedUser;
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const b = req.body ?? {};
    const name = typeof b.name === "string" ? b.name.trim() : "";
    const size = Number(b.size);
    const contentType =
      typeof b.contentType === "string" ? b.contentType.trim() : "";
    if (!name || !contentType || !Number.isFinite(size) || size <= 0) {
      res.status(400).json({ error: "name, size, contentType required" });
      return;
    }
    if (size > MAX_UPLOAD_BYTES) {
      res
        .status(413)
        .json({ error: `File too large (max ${MAX_UPLOAD_BYTES} bytes)` });
      return;
    }
    // Reject upfront any MIME the artifact route would coerce to
    // octet-stream. Issuing presigned URLs for arbitrary types only invites
    // wasted bandwidth + storage cost.
    const declared = contentType.toLowerCase();
    if (!ALLOWED_MIME.has(declared)) {
      res.status(415).json({ error: "Unsupported content type" });
      return;
    }
    try {
      const uploadURL = await objectStorage.getObjectEntityUploadURL();
      const objectPath = objectStorage.normalizeObjectEntityPath(uploadURL);
      await db.insert(artifactUploadIntentsTable).values({
        engagementId: id,
        userId: user.id,
        objectKey: objectPath,
        expiresAt: new Date(Date.now() + UPLOAD_INTENT_TTL_MS),
      });
      res.json({ uploadURL, objectPath });
    } catch (err) {
      req.log.error({ err }, "Failed to issue upload URL");
      res.status(500).json({ error: "Failed to generate upload URL" });
    }
  },
);

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
  // Coerce any disallowed MIME to a safe bucket. `octet-stream` is treated
  // as a binary blob downloaded as an attachment, so even if a client tries
  // to upload `text/html` to host an XSS payload, we won't ever serve it
  // back as HTML in our origin.
  const requestedMime =
    typeof b.mimeType === "string" && b.mimeType.trim()
      ? b.mimeType.trim().toLowerCase()
      : "text/plain";
  const mimeType = ALLOWED_MIME.has(requestedMime)
    ? requestedMime
    : "application/octet-stream";

  // The browser uploaded the binary directly to GCS via a presigned URL
  // and is now telling us the canonical objectPath plus the original byte
  // size. Verify this objectKey matches an upload intent we issued to
  // *this* user for *this* engagement and hasn't already been consumed —
  // otherwise an authenticated user could register someone else's object
  // and read it back via the authorized download route (BOLA).
  let objectKey = "";
  let binaryBytes = 0;
  let intentId: string | null = null;
  if (typeof b.objectPath === "string" && b.objectPath.trim()) {
    const candidate = b.objectPath.trim();
    if (!candidate.startsWith("/objects/")) {
      res.status(400).json({ error: "Invalid objectPath" });
      return;
    }
    const user = req.authedUser;
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const now = new Date();
    const [intent] = await db
      .select()
      .from(artifactUploadIntentsTable)
      .where(
        and(
          eq(artifactUploadIntentsTable.objectKey, candidate),
          eq(artifactUploadIntentsTable.engagementId, id),
          eq(artifactUploadIntentsTable.userId, user.id),
          isNull(artifactUploadIntentsTable.consumedAt),
          gt(artifactUploadIntentsTable.expiresAt, now),
        ),
      )
      .limit(1);
    if (!intent) {
      res
        .status(400)
        .json({ error: "Unknown or expired upload — request a new URL" });
      return;
    }
    objectKey = candidate;
    intentId = intent.id;
    const parsedSize = Number(b.sizeBytes);
    if (Number.isFinite(parsedSize) && parsedSize > 0) {
      binaryBytes = Math.min(Math.floor(parsedSize), MAX_UPLOAD_BYTES);
    }
  }

  // For docx/pptx the client uploads only the raw binary (to object storage)
  // and ships an empty `content`. Fetch the bytes back from GCS here and run
  // the appropriate extractor so the rubric/evidence pipeline still has
  // searchable text. PDFs are extracted in the browser via pdf.js (kept off
  // the server to avoid the worker/font baggage).
  let content = b.content;
  if (
    objectKey &&
    SERVER_EXTRACTABLE_MIME.has(mimeType) &&
    content.trim().length === 0
  ) {
    try {
      const file = await objectStorage.getObjectEntityFile(objectKey);
      const [buffer] = await file.download();
      content =
        mimeType === DOCX_MIME
          ? await extractDocxText(buffer)
          : await extractPptxText(buffer);
    } catch (err) {
      res.status(422).json({
        error: `Could not extract text from ${b.filename}: ${
          err instanceof Error ? err.message : "unknown error"
        }`,
      });
      return;
    }
    if (!content.trim()) {
      // Keep a placeholder so downstream code that assumes non-empty content
      // (summary slicing, rubric search) still has something deterministic.
      content = `[${b.filename} — no extractable text found]`;
    }
  }
  const summary = content.length > 280 ? content.slice(0, 277) + "..." : content;
  // Insert + intent consume in a single transaction so a failed insert
  // doesn't burn the intent (preventing a retry) and a successful insert
  // never leaves an unconsumed intent for the same object key around.
  const a = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(artifactDocsTable)
      .values({
        engagementId: id,
        filename: b.filename,
        kind: b.kind,
        // Prefer the original binary size; fall back to the extracted text size
        // for legacy paste-only uploads.
        sizeBytes: binaryBytes || Buffer.byteLength(content, "utf8"),
        content,
        extractedSummary: summary,
        mimeType,
        objectKey,
      })
      .returning();
    if (intentId) {
      await tx
        .update(artifactUploadIntentsTable)
        .set({ consumedAt: new Date() })
        .where(eq(artifactUploadIntentsTable.id, intentId));
    }
    return row;
  });
  await recordActivity(req, {
    engagementId: id,
    kind: "artifact_uploaded",
    message: `Artifact uploaded: ${a.filename}`,
    payload: { artifactId: a.id, filename: a.filename, kind: a.kind, sizeBytes: a.sizeBytes },
  });
  res.status(201).json(shape(a));
});

router.get(
  "/artifacts/:artifactId/download",
  requireArtifactMember,
  async (req, res): Promise<void> => {
    const id = paramId(req.params.artifactId);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [a] = await db
      .select()
      .from(artifactDocsTable)
      .where(eq(artifactDocsTable.id, id))
      .limit(1);
    if (!a) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    // Re-validate the stored MIME against the allowlist on every serve.
    // Rows uploaded before this allowlist landed, or rows somehow holding a
    // disallowed value, are demoted to octet-stream + attachment so they
    // can never be rendered as HTML/script in the app origin.
    const storedMime = a.objectKey ? a.mimeType : "text/plain";
    const safeMime = ALLOWED_MIME.has(storedMime)
      ? storedMime
      : "application/octet-stream";
    const disposition = INLINE_SAFE_MIME.has(safeMime) ? "inline" : "attachment";
    res.setHeader(
      "Content-Type",
      safeMime === "text/plain" ? "text/plain; charset=utf-8" : safeMime,
    );
    // X-Content-Type-Options prevents MIME sniffing — keeps a renamed PDF
    // (or any file the browser might "helpfully" sniff) from being treated
    // as anything other than what we declared.
    res.setHeader("X-Content-Type-Options", "nosniff");
    // RFC 5987 quoting so non-ASCII filenames survive the round-trip.
    const safeName = a.filename.replace(/"/g, "");
    res.setHeader(
      "Content-Disposition",
      `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
    );

    if (!a.objectKey) {
      // Legacy paste-only upload (no binary): stream the extracted text.
      // (The pre-migration `data_base64` fallback was removed once
      // `migrateLegacyArtifactBlobs` finished and dropped the column.)
      const buffer = Buffer.from(a.content, "utf8");
      res.setHeader("Content-Length", String(buffer.length));
      res.end(buffer);
      return;
    }

    // Binary lives in object storage — stream it through this endpoint so
    // the requireArtifactMember auth check still gates access. We deliberately
    // do NOT 302 to the GCS signed URL because that would leak data to anyone
    // with the artifactId.
    try {
      const file = await objectStorage.getObjectEntityFile(a.objectKey);
      const [metadata] = await file.getMetadata();
      if (metadata.size) {
        res.setHeader("Content-Length", String(metadata.size));
      }
      file.createReadStream().on("error", (err) => {
        req.log.error({ err }, "Object storage stream error");
        if (!res.headersSent) res.status(500).json({ error: "Read failed" });
        else res.end();
      }).pipe(res);
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "Object not found" });
        return;
      }
      req.log.error({ err }, "Failed to fetch artifact object");
      res.status(500).json({ error: "Failed to read object" });
    }
  },
);

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
    // Best-effort cleanup of the GCS object — failures here shouldn't block
    // the API response since the row is already gone, but we log them so an
    // operator can sweep orphaned objects later if needed.
    if (doomed.objectKey) {
      try {
        const file = await objectStorage.getObjectEntityFile(doomed.objectKey);
        await file.delete({ ignoreNotFound: true });
      } catch (err) {
        req.log.warn({ err, objectKey: doomed.objectKey }, "Failed to delete artifact object");
      }
    }
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
