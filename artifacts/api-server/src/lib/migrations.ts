import { eq, isNotNull, sql } from "drizzle-orm";
import {
  db,
  connectorsTable,
  artifactDocsTable,
  scoringTable,
  engagementScoringSnapshotsTable,
} from "@workspace/db";
import { decryptToken, encryptToken, isCurrentTokenFormat, TokenDecryptError } from "./util";
import { ObjectStorageService } from "./objectStorage";
import { randomUUID } from "crypto";
import { monthBucket, upsertScoringSnapshot } from "./scoring";
import { recordSystemActivity } from "./audit";
import { logger } from "./logger";

export interface TokenMigrationSummary {
  scanned: number;
  migrated: number;
  failed: number;
  alreadyV1: number;
}

/**
 * Re-encrypts any connector rows whose `encrypted_token` is not already in
 * the current KMS-backed envelope into `kms:v1:` format. Catches both the
 * pre-v1 base64 obfuscation and the static-key `v1:` envelope so the bulk
 * upgrade and the lazy-on-read upgrade in `executeConnectorRun` agree on
 * what "current" means.
 *
 * Idempotent: rows already in `kms:v1:` (and pinned to the active keyRef)
 * are skipped. Rows that fail to decrypt (corrupt or hand-edited) are
 * logged and skipped — operators can re-enter the token via the cockpit.
 *
 * Per PRD §6.2: every successful migration emits a `connector_token_migrated`
 * audit row so a compliance scan can confirm coverage without diffing rows.
 */
export async function migrateLegacyConnectorTokens(): Promise<TokenMigrationSummary> {
  // We can't filter "not kms:v1" cheaply in SQL without listing every legacy
  // shape, so fetch all non-null rows and decide in JS. Token rows are tiny
  // and there are O(connectors-per-deployment) of them — well under any
  // reasonable bound.
  const rows = await db
    .select({
      id: connectorsTable.id,
      engagementId: connectorsTable.engagementId,
      label: connectorsTable.label,
      encryptedToken: connectorsTable.encryptedToken,
    })
    .from(connectorsTable)
    .where(isNotNull(connectorsTable.encryptedToken));

  let migrated = 0;
  let failed = 0;
  let alreadyCurrent = 0;
  for (const r of rows) {
    if (!r.encryptedToken) continue;
    if (isCurrentTokenFormat(r.encryptedToken)) {
      alreadyCurrent += 1;
      continue;
    }
    try {
      const plain = decryptToken(r.encryptedToken);
      const upgraded = encryptToken(plain);
      await db
        .update(connectorsTable)
        .set({ encryptedToken: upgraded })
        .where(eq(connectorsTable.id, r.id));
      // Audit row per migrated token so compliance can answer "were all
      // legacy tokens upgraded?" by querying activity_events directly.
      await recordSystemActivity({
        engagementId: r.engagementId,
        kind: "connector_token_migrated",
        severity: "info",
        message: `Connector token re-encrypted into KMS envelope: ${r.label}`,
        payload: {
          connectorId: r.id,
          path: "bulk-on-boot",
        },
      });
      migrated += 1;
    } catch (e) {
      failed += 1;
      const reason =
        e instanceof TokenDecryptError ? e.message : String(e);
      logger.warn(
        { connectorId: r.id, reason },
        "Skipped legacy connector token (decrypt failed)",
      );
    }
  }
  return {
    scanned: rows.length,
    migrated,
    failed,
    alreadyV1: alreadyCurrent,
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

export interface ConnectorLookbackMigrationSummary {
  engagementColumnAdded: boolean;
  runColumnsAdded: boolean;
}

/**
 * Adds the configurable-lookback + resumable-cursor columns to existing
 * Postgres deployments that predate the schema. Idempotent — uses
 * `IF NOT EXISTS` so re-running on a fresh DB (where drizzle-kit push has
 * already created the columns) is a no-op. Without this, the first server
 * boot after the schema change against a long-lived prod DB would crash
 * every connector run and every engagement read.
 */
export async function migrateConnectorLookbackColumns(): Promise<ConnectorLookbackMigrationSummary> {
  const engCheck = await db.execute(sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'engagements' AND column_name = 'connector_lookback_days'
    LIMIT 1
  `);
  const engagementColumnExisted = (engCheck.rows ?? []).length > 0;
  if (!engagementColumnExisted) {
    await db.execute(sql`
      ALTER TABLE engagements
      ADD COLUMN IF NOT EXISTS connector_lookback_days INTEGER NOT NULL DEFAULT 90
    `);
  }

  const runCheck = await db.execute(sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'connector_runs' AND column_name = 'cursors'
    LIMIT 1
  `);
  const runColumnsExisted = (runCheck.rows ?? []).length > 0;
  if (!runColumnsExisted) {
    await db.execute(sql`
      ALTER TABLE connector_runs
      ADD COLUMN IF NOT EXISTS cursors JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS coverage JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS lookback_days INTEGER,
      ADD COLUMN IF NOT EXISTS wall_clock_budget_ms INTEGER
    `);
  }

  return {
    engagementColumnAdded: !engagementColumnExisted,
    runColumnsAdded: !runColumnsExisted,
  };
}

export interface ScoringSnapshotBackfillSummary {
  scoringRows: number;
  inserted: number;
  alreadyPresent: number;
}

/**
 * One-shot backfill that writes a `engagement_scoring_snapshots` row for
 * each existing scoring at its `computedAt` month. Without this, the
 * Portfolio history strip would be empty until the next time someone
 * recomputes scoring for each engagement.
 *
 * Idempotent: any engagement that already has snapshots is skipped, so
 * re-running on every boot is cheap and safe. Only engagements with no
 * snapshots at all get a single seed row from their current scoring.
 */
export async function backfillScoringSnapshots(): Promise<ScoringSnapshotBackfillSummary> {
  const allScorings = await db.select().from(scoringTable);
  if (allScorings.length === 0) {
    return { scoringRows: 0, inserted: 0, alreadyPresent: 0 };
  }
  const existing = await db
    .select({ engagementId: engagementScoringSnapshotsTable.engagementId })
    .from(engagementScoringSnapshotsTable);
  const haveSnapshot = new Set(existing.map((r) => r.engagementId));

  let inserted = 0;
  let alreadyPresent = 0;
  for (const s of allScorings) {
    if (haveSnapshot.has(s.engagementId)) {
      alreadyPresent += 1;
      continue;
    }
    const overall = (s.overall ?? {}) as { stage?: number; score?: number };
    if (typeof overall.stage !== "number" || typeof overall.score !== "number") {
      continue; // Scoring exists but is empty — skip; next compute will fill it.
    }
    const byDim = (s.byDimension ?? []) as Array<{
      dimension: string;
      stage: number;
    }>;
    const byDimensionStages = Object.fromEntries(
      byDim
        .filter((d) => typeof d.stage === "number" && typeof d.dimension === "string")
        .map((d) => [d.dimension, d.stage]),
    );
    await upsertScoringSnapshot({
      engagementId: s.engagementId,
      snapshotMonth: monthBucket(s.computedAt),
      overallStage: overall.stage,
      overallScore: overall.score,
      byDimensionStages,
    });
    inserted += 1;
  }
  return {
    scoringRows: allScorings.length,
    inserted,
    alreadyPresent,
  };
}

