import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
} from "node:crypto";

/**
 * Connector token storage uses a KMS-backed envelope encryption scheme
 * instead of a single static AES key kept in app config. The pattern matches
 * what a managed KMS (AWS KMS, GCP KMS, Replit-hosted KMS) gives us:
 *
 *   1. Each token gets its own random 32-byte Data Encryption Key (DEK).
 *   2. The token is encrypted with the DEK using AES-256-GCM.
 *   3. The DEK is "wrapped" by a Key Encryption Key (KEK) selected via
 *      a KMS keyRef. We never persist a usable cleartext DEK or KEK.
 *   4. The ciphertext + wrapped DEK + the keyRef are stored together so
 *      decryption only needs the keyRef to ask the KMS to unwrap the DEK.
 *
 * The KEKs themselves are derived (in this build) from the platform root
 * secret via HKDF, with a per-keyRef label. In a hosted-KMS deployment the
 * `wrapDek` / `unwrapDek` functions become RPCs against the KMS service —
 * the on-disk envelope and call shape do not change. This keeps the migration
 * path "swap the kms.ts implementation" with zero churn upstream.
 *
 * The active keyRef can be rotated without touching existing rows: rows store
 * the ref they were wrapped with, and we lazily re-encrypt them on read into
 * the current `KMS_ACTIVE_KEY_REF` (handled by util.encryptToken via
 * `wrapWithCurrent`). Old refs remain decryptable as long as their KEK is
 * still configured.
 */

function hkdfKey(rootSecret: string, label: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", rootSecret, label, "pulse-kms-v1", 32),
  );
}

function loadConfiguredKeks(): Record<string, Buffer> {
  // Operators can pin specific KEKs (e.g. a JSON map of ref → 32-byte
  // base64/hex key) via PULSE_KMS_KEYS. Falls back to deriving a single
  // "default" KEK from the platform root secret.
  const raw = process.env.PULSE_KMS_KEYS;
  const root =
    process.env.SESSION_SECRET ??
    process.env.PULSE_ROOT_KEY ??
    "pulse-dev-insecure-root-do-not-use-in-prod";
  const out: Record<string, Buffer> = {
    default: hkdfKey(root, "kek-default-v1"),
  };
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    for (const [ref, val] of Object.entries(parsed)) {
      let buf: Buffer | null = null;
      if (/^[0-9a-fA-F]{64}$/.test(val)) buf = Buffer.from(val, "hex");
      else {
        try {
          const b = Buffer.from(val, "base64");
          if (b.length === 32) buf = b;
        } catch {
          /* ignore */
        }
      }
      if (buf) out[ref] = buf;
    }
  } catch {
    // Malformed PULSE_KMS_KEYS is non-fatal — we keep the derived default
    // key so the server still boots. Operators see it via the warning log.
    // eslint-disable-next-line no-console
    console.warn(
      "[pulse:kms] PULSE_KMS_KEYS is not valid JSON; ignoring and using derived default KEK.",
    );
  }
  return out;
}

const KEKS: Record<string, Buffer> = loadConfiguredKeks();

/** The keyRef new wraps will use. Older refs remain decryptable. */
export const KMS_ACTIVE_KEY_REF: string =
  process.env.PULSE_KMS_ACTIVE_REF && KEKS[process.env.PULSE_KMS_ACTIVE_REF]
    ? process.env.PULSE_KMS_ACTIVE_REF
    : "default";

export class KmsError extends Error {
  constructor(reason: string) {
    super(`KMS: ${reason}`);
    this.name = "KmsError";
  }
}

export interface WrappedDek {
  keyRef: string;
  wDek: Buffer; // ciphertext of the DEK
  wIv: Buffer; // 12-byte IV used to wrap
  wTag: Buffer; // 16-byte GCM tag
}

/**
 * Generate a fresh DEK and ask the KMS to wrap it under the active keyRef.
 * Returns both the cleartext DEK (caller uses it once to encrypt the token,
 * then drops it) and the wrapped form for storage.
 */
export function generateAndWrapDek(): { dek: Buffer; wrapped: WrappedDek } {
  const dek = randomBytes(32);
  const wrapped = wrapDek(dek, KMS_ACTIVE_KEY_REF);
  return { dek, wrapped };
}

export function wrapDek(dek: Buffer, keyRef: string = KMS_ACTIVE_KEY_REF): WrappedDek {
  const kek = KEKS[keyRef];
  if (!kek) throw new KmsError(`unknown keyRef "${keyRef}"`);
  if (dek.length !== 32) throw new KmsError("DEK must be 32 bytes");
  const wIv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kek, wIv);
  const wDek = Buffer.concat([cipher.update(dek), cipher.final()]);
  const wTag = cipher.getAuthTag();
  return { keyRef, wDek, wIv, wTag };
}

export function unwrapDek(wrapped: WrappedDek): Buffer {
  const kek = KEKS[wrapped.keyRef];
  if (!kek) {
    throw new KmsError(
      `unknown keyRef "${wrapped.keyRef}" — KEK not configured on this server`,
    );
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", kek, wrapped.wIv);
    decipher.setAuthTag(wrapped.wTag);
    const dek = Buffer.concat([decipher.update(wrapped.wDek), decipher.final()]);
    if (dek.length !== 32) throw new KmsError("unwrapped DEK has wrong length");
    return dek;
  } catch (e) {
    throw new KmsError(
      e instanceof Error ? e.message : "unwrap failed",
    );
  }
}
