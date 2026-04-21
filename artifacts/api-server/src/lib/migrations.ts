import { eq, and, isNotNull, not, like, sql } from "drizzle-orm";
import { db, connectorsTable, artifactDocsTable } from "@workspace/db";
import { decryptToken, encryptToken, TokenDecryptError } from "./util";
import { ObjectStorageService } from "./objectStorage";
import { randomUUID } from "crypto";

export interface TokenMigrationSummary {
  scanned: number;
  migrated: number;
  failed: number;
  alreadyV1: number;
}

/**
 * Re-encrypts any connector rows whose `encrypted_token` is still in the
 * legacy base64 format (no `v1:` prefix) into the AES-256-GCM envelope.
 *
 * Idempotent: rows already in v1 format are left untouched. Rows that fail
 * to decrypt (corrupt or hand-edited) are logged and skipped — operators
 * can re-enter the token via the cockpit.
 *
 * After every connector token has been migrated we can drop the legacy
 * branch in `decryptToken`. Track that follow-up in the threat model.
 */
export async function migrateLegacyConnectorTokens(): Promise<TokenMigrationSummary> {
  const rows = await db
    .select({ id: connectorsTable.id, encryptedToken: connectorsTable.encryptedToken })
    .from(connectorsTable)
    .where(
      and(
        isNotNull(connectorsTable.encryptedToken),
        // Anything not already prefixed with `v1:` is candidate legacy.
        not(like(connectorsTable.encryptedToken, "v1:%")),
      ),
    );

  let migrated = 0;
  let failed = 0;
  for (const r of rows) {
    if (!r.encryptedToken) continue;
    try {
      const plain = decryptToken(r.encryptedToken);
      const upgraded = encryptToken(plain);
      await db
        .update(connectorsTable)
        .set({ encryptedToken: upgraded })
        .where(eq(connectorsTable.id, r.id));
      migrated += 1;
    } catch (e) {
      failed += 1;
      const reason =
        e instanceof TokenDecryptError ? e.message : String(e);
      // eslint-disable-next-line no-console
      console.warn(
        `[pulse] Skipped legacy connector token ${r.id}: ${reason}`,
      );
    }
  }
  return {
    scanned: rows.length,
    migrated,
    failed,
    alreadyV1: 0,
  };
}

export interface ArtifactBlobMigrationSummary {
  scanned: number;
  migrated: number;
  failed: number;
  legacyColumnDropped: boolean;
}

/**
 * One-shot backfill of inline base64 artifact blobs into object storage.
 *
 * Pulse v1 stored uploaded PDFs as base64 in `artifact_docs.data_base64`.
 * v2 (this change) moves the bytes to App Storage and replaces the column
 * with `object_key`. On a freshly migrated DB the legacy column is already
 * gone and this function is a no-op; on a DB that still carries the column
 * we:
 *
 *   1. Scan every row whose `data_base64` is non-empty.
 *   2. Upload the decoded bytes to a fresh object storage key.
 *   3. Set `object_key` for that row.
 *   4. NULL out `data_base64` so a re-run skips it.
 *   5. Once every row migrates cleanly, drop the legacy column.
 *
 * Idempotent: running twice is safe because step 4 unsets the source data.
 * Failures on individual rows are logged and counted; the column is only
 * dropped when the scan completes with zero remaining non-empty rows.
 */
export async function migrateLegacyArtifactBlobs(): Promise<ArtifactBlobMigrationSummary> {
  // Detect the legacy column without relying on a stale generated schema.
  const colCheck = await db.execute(sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'artifact_docs' AND column_name = 'data_base64'
    LIMIT 1
  `);
  const legacyExists = (colCheck.rows ?? []).length > 0;
  if (!legacyExists) {
    return { scanned: 0, migrated: 0, failed: 0, legacyColumnDropped: false };
  }

  const objectStorage = new ObjectStorageService();
  const privateDir = objectStorage.getPrivateObjectDir();

  type LegacyRow = { id: string; data_base64: string; mime_type: string };
  const result = await db.execute<LegacyRow>(sql`
    SELECT id, data_base64, mime_type
    FROM artifact_docs
    WHERE data_base64 IS NOT NULL AND length(data_base64) > 0
  `);
  const rows = result.rows ?? [];

  let migrated = 0;
  let failed = 0;
  // Defer to require so we don't drag GCS into the bundle when there's
  // nothing to migrate.
  const { objectStorageClient } = await import("./objectStorage");
  for (const row of rows) {
    try {
      const buffer = Buffer.from(row.data_base64, "base64");
      const objectId = randomUUID();
      const objectPath = `/objects/uploads/${objectId}`;
      // Map `/objects/uploads/<id>` to its full GCS path the same way
      // ObjectStorageService.getObjectEntityFile does, so the existing
      // download streaming logic finds it.
      let entityDir = privateDir;
      if (!entityDir.endsWith("/")) entityDir = `${entityDir}/`;
      const fullPath = `${entityDir}uploads/${objectId}`;
      const parts = fullPath.replace(/^\//, "").split("/");
      const bucketName = parts[0];
      const objectName = parts.slice(1).join("/");
      if (!bucketName) throw new Error("Invalid PRIVATE_OBJECT_DIR");
      const file = objectStorageClient.bucket(bucketName).file(objectName);
      await file.save(buffer, {
        contentType: row.mime_type || "application/octet-stream",
        resumable: false,
      });
      await db
        .update(artifactDocsTable)
        .set({ objectKey: objectPath })
        .where(eq(artifactDocsTable.id, row.id));
      await db.execute(
        sql`UPDATE artifact_docs SET data_base64 = '' WHERE id = ${row.id}`,
      );
      migrated += 1;
    } catch (e) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.warn(
        `[pulse] Failed to migrate artifact blob ${row.id}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  // Only drop the legacy column when nothing's left to migrate. Leaving
  // failed rows in place keeps the data recoverable on the next boot.
  let legacyColumnDropped = false;
  if (failed === 0) {
    await db.execute(sql`ALTER TABLE artifact_docs DROP COLUMN data_base64`);
    legacyColumnDropped = true;
  }

  return {
    scanned: rows.length,
    migrated,
    failed,
    legacyColumnDropped,
  };
}
