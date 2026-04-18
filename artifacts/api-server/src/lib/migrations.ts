import { eq, and, isNotNull, not, like } from "drizzle-orm";
import { db, connectorsTable } from "@workspace/db";
import { decryptToken, encryptToken, TokenDecryptError } from "./util";

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
