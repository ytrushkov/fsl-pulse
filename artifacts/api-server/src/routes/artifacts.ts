import { Router, type IRouter } from "express";
import { eq, desc, sql } from "drizzle-orm";
import {
  db,
  artifactDocsTable,
  evidenceTable,
} from "@workspace/db";

// MIME types we allow uploaders to declare. Anything else is coerced to
// `application/octet-stream` on serve so a malicious upload can't be
// rendered inline as HTML/JS in the app origin (stored XSS defence).
const ALLOWED_MIME = new Set<string>([
  "application/pdf",
  "text/plain",
  "text/markdown",
]);
// Only these types are safe to render inline in the browser. Anything else
// (including PDFs that happen to declare an unknown subtype) is forced as
// an attachment download.
const INLINE_SAFE_MIME = new Set<string>([
  "application/pdf",
  "text/plain",
]);
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
    mimeType: a.mimeType,
    hasBinary: Boolean(a.dataBase64 && a.dataBase64.length > 0),
    createdAt: a.createdAt.toISOString(),
  };
}

// Cap inline-base64 uploads at ~25MB of decoded bytes. base64 inflates by ~4/3,
// so the payload itself can be ~33MB — well below Express' default JSON limit
// once we bump it. Anything larger than this should move to object storage.
const MAX_BINARY_BYTES = 25 * 1024 * 1024;

router.get("/engagements/:id/artifacts", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  // Project metadata columns only — never load `dataBase64` here. Pulling
  // every binary blob into memory just to serve a list view would balloon
  // memory use and slow the page to a crawl as the vault grows.
  const rows = await db
    .select({
      id: artifactDocsTable.id,
      engagementId: artifactDocsTable.engagementId,
      filename: artifactDocsTable.filename,
      kind: artifactDocsTable.kind,
      sizeBytes: artifactDocsTable.sizeBytes,
      extractedSummary: artifactDocsTable.extractedSummary,
      mimeType: artifactDocsTable.mimeType,
      createdAt: artifactDocsTable.createdAt,
      // Cheap boolean derived in SQL — avoids shipping the whole base64
      // string just to compute `hasBinary` client-side.
      hasBinary: sql<boolean>`length(${artifactDocsTable.dataBase64}) > 0`,
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
      hasBinary: Boolean(r.hasBinary),
      createdAt: r.createdAt.toISOString(),
    })),
  );
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
  const dataBase64 = typeof b.dataBase64 === "string" ? b.dataBase64 : "";
  // Decoded byte size — used both for the size column (so the UI can show
  // "1.2 MB" rather than the inflated base64 length) and for the cap check.
  let binaryBytes = 0;
  if (dataBase64) {
    binaryBytes = Math.floor((dataBase64.length * 3) / 4);
    if (binaryBytes > MAX_BINARY_BYTES) {
      res.status(413).json({
        error: `File too large. Max ${MAX_BINARY_BYTES / (1024 * 1024)}MB.`,
      });
      return;
    }
  }
  const summary = b.content.length > 280 ? b.content.slice(0, 277) + "..." : b.content;
  const [a] = await db
    .insert(artifactDocsTable)
    .values({
      engagementId: id,
      filename: b.filename,
      kind: b.kind,
      // Prefer the original binary size; fall back to the extracted text size
      // for legacy paste-only uploads.
      sizeBytes: binaryBytes || Buffer.byteLength(b.content, "utf8"),
      content: b.content,
      extractedSummary: summary,
      mimeType,
      dataBase64,
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
    // When a binary is on file, stream it back with the stored MIME type so
    // PDFs render in the browser. For legacy paste-only rows fall back to the
    // extracted text content as text/plain.
    const buffer = a.dataBase64
      ? Buffer.from(a.dataBase64, "base64")
      : Buffer.from(a.content, "utf8");
    // Re-validate the stored MIME against the allowlist on every serve.
    // Rows uploaded before this allowlist landed, or rows somehow holding a
    // disallowed value, are demoted to octet-stream + attachment so they
    // can never be rendered as HTML/script in the app origin.
    const storedMime = a.dataBase64 ? a.mimeType : "text/plain";
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
    res.setHeader("Content-Length", String(buffer.length));
    res.end(buffer);
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
