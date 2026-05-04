import {
  randomBytes,
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  timingSafeEqual,
} from "node:crypto";
import { isIP } from "node:net";
import { promises as dns } from "node:dns";

export function paramId(p: string | string[] | undefined): string | null {
  if (!p) return null;
  return Array.isArray(p) ? p[0] : p;
}

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------
// We derive distinct purpose-specific 32-byte keys from a single root secret
// (SESSION_SECRET) using HKDF-SHA256. Operators can override with dedicated
// PULSE_TOKEN_KEY / PULSE_EXPORT_KEY env vars (hex- or base64-encoded 32 bytes)
// when migrating to a managed KMS.

function resolveRootSecret(): string {
  const fromEnv =
    process.env.SESSION_SECRET ?? process.env.PULSE_ROOT_KEY ?? "";
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  // In production, refuse to derive cryptographic keys from a known/empty
  // value. Doing so would let anyone with the source code decrypt connector
  // tokens or forge export signatures.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to start: SESSION_SECRET (or PULSE_ROOT_KEY) must be set to " +
        "at least 16 characters in production. This secret is used to derive " +
        "AES-256-GCM connector-token keys and HMAC export-signing keys.",
    );
  }
  // Dev-only fallback so the server boots without a configured secret. NEVER
  // used in production thanks to the guard above. We log loudly so a misset
  // NODE_ENV doesn't sneak past unnoticed.
  // eslint-disable-next-line no-console
  console.warn(
    "[pulse] WARNING: using insecure dev fallback for SESSION_SECRET — " +
      "set SESSION_SECRET (>= 16 chars) before deploying.",
  );
  return "pulse-dev-insecure-root-do-not-use-in-prod";
}

const ROOT_SECRET = resolveRootSecret();

function decodeKey(raw: string): Buffer | null {
  try {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
    const b = Buffer.from(raw, "base64");
    if (b.length === 32) return b;
  } catch {
    /* fall through */
  }
  return null;
}

function deriveKey(label: string): Buffer {
  // HKDF: salt is the label so different labels yield independent keys.
  const out = hkdfSync("sha256", ROOT_SECRET, label, "pulse-v1", 32);
  return Buffer.from(out);
}

const TOKEN_KEY: Buffer = process.env.PULSE_TOKEN_KEY
  ? (decodeKey(process.env.PULSE_TOKEN_KEY) ?? deriveKey("pulse-token-v1"))
  : deriveKey("pulse-token-v1");

const EXPORT_KEY: Buffer = process.env.PULSE_EXPORT_KEY
  ? (decodeKey(process.env.PULSE_EXPORT_KEY) ?? deriveKey("pulse-export-v1"))
  : deriveKey("pulse-export-v1");

// ---------------------------------------------------------------------------
// Connector token envelope encryption
// ---------------------------------------------------------------------------
// New rows use KMS-backed envelope encryption (`kms:v1:` prefix). The DEK is
// generated per-token, the token is sealed with AES-256-GCM under the DEK,
// and the DEK itself is wrapped by the KMS under a named keyRef. See
// `kms.ts` for the rationale.
//
// Legacy formats are still readable so engagements created on prior builds
// survive the upgrade — tokens get lazily re-encrypted into the KMS envelope
// the next time they are read by the runner / route layer (see
// `migrateLegacyConnectorTokens` for the eager bulk path):
//   * `v1:<iv>:<tag>:<ct>`        → AES-256-GCM under the static TOKEN_KEY
//   * `<base64-of-plaintext>`     → pre-v1 obfuscation
import {
  generateAndWrapDek,
  unwrapDek,
  KMS_ACTIVE_KEY_REF,
  KmsError,
  type WrappedDek,
} from "./kms";

const KMS_PREFIX = "kms:v1:";
const ENC_PREFIX = "v1:";

export function encryptToken(plain: string): string {
  // Default path for newly stored tokens: KMS-backed envelope encryption.
  const { dek, wrapped } = generateAndWrapDek();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Drop the cleartext DEK from memory ASAP. JS doesn't let us truly zero
  // a Buffer that may still be referenced by the cipher object, but we at
  // least avoid keeping a separate strong reference.
  dek.fill(0);
  return [
    KMS_PREFIX + wrapped.keyRef,
    wrapped.wDek.toString("base64url"),
    wrapped.wIv.toString("base64url"),
    wrapped.wTag.toString("base64url"),
    iv.toString("base64url"),
    tag.toString("base64url"),
    ct.toString("base64url"),
  ].join(":");
}

/**
 * Encrypt using the legacy `v1:` static-key envelope. Used only by the
 * migration path that needs to round-trip an existing v1 row through the
 * KMS-backed format without changing semantics. Production callers should
 * use `encryptToken` (which now writes `kms:v1:` envelopes).
 */
export function encryptTokenLegacyV1(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", TOKEN_KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${ct.toString("base64url")}`;
}

/**
 * True when the stored value is already in the current (KMS-backed) format.
 * Callers use this to decide whether to lazily re-encrypt on read.
 */
export function isCurrentTokenFormat(stored: string | null | undefined): boolean {
  if (!stored) return false;
  if (!stored.startsWith(KMS_PREFIX)) return false;
  // Optionally enforce that the keyRef matches the active rotation target.
  const ref = stored.slice(KMS_PREFIX.length).split(":", 1)[0] ?? "";
  return ref === KMS_ACTIVE_KEY_REF;
}

export class TokenDecryptError extends Error {
  constructor(reason: string) {
    super(`Token decryption failed: ${reason}`);
    this.name = "TokenDecryptError";
  }
}

const STRICT_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decrypt a stored connector token. Throws `TokenDecryptError` on any failure
 * so callers (route handlers) can surface a clear "connector misconfigured"
 * message to the assessor instead of silently calling the upstream API with
 * an empty bearer token.
 *
 * Handles three on-disk formats so a running deployment can carry rows from
 * any prior shape: KMS-backed envelope (`kms:v1:`), static-key AES-GCM
 * envelope (`v1:`), and pre-v1 plain base64.
 */
export function decryptToken(stored: string): string {
  if (stored.startsWith(KMS_PREFIX)) {
    const parts = stored.slice(KMS_PREFIX.length).split(":");
    if (parts.length !== 7) {
      throw new TokenDecryptError("malformed kms:v1 envelope");
    }
    const [keyRef, wDekB64, wIvB64, wTagB64, ivB64, tagB64, ctB64] = parts;
    let dek: Buffer | null = null;
    try {
      const wrapped: WrappedDek = {
        keyRef: keyRef!,
        wDek: Buffer.from(wDekB64!, "base64url"),
        wIv: Buffer.from(wIvB64!, "base64url"),
        wTag: Buffer.from(wTagB64!, "base64url"),
      };
      dek = unwrapDek(wrapped);
      const iv = Buffer.from(ivB64!, "base64url");
      const tag = Buffer.from(tagB64!, "base64url");
      const ct = Buffer.from(ctB64!, "base64url");
      const decipher = createDecipheriv("aes-256-gcm", dek, iv);
      decipher.setAuthTag(tag);
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      return pt.toString("utf8");
    } catch (e) {
      if (e instanceof KmsError) throw new TokenDecryptError(e.message);
      throw new TokenDecryptError(
        e instanceof Error ? e.message : "unknown cipher error",
      );
    } finally {
      if (dek) dek.fill(0);
    }
  }
  if (!stored.startsWith(ENC_PREFIX)) {
    // Legacy obfuscated value (pre-v1 ciphertext format). Validate strictly
    // before decoding so corrupted rows fail loudly instead of yielding empty
    // or garbage plaintext.
    if (!STRICT_BASE64_RE.test(stored)) {
      throw new TokenDecryptError("legacy value has invalid base64 alphabet");
    }
    let decoded: Buffer;
    try {
      decoded = Buffer.from(stored, "base64");
    } catch {
      throw new TokenDecryptError("legacy base64 decode failed");
    }
    // Round-trip check: Node base64 decoding is permissive and silently
    // accepts garbage. Reject any value that doesn't decode-encode to itself.
    if (decoded.toString("base64").replace(/=+$/, "") !== stored.replace(/=+$/, "")) {
      throw new TokenDecryptError("legacy base64 did not round-trip");
    }
    const out = decoded.toString("utf8");
    if (out.length === 0) {
      throw new TokenDecryptError("legacy plaintext is empty");
    }
    return out;
  }
  const parts = stored.slice(ENC_PREFIX.length).split(":");
  if (parts.length !== 3) {
    throw new TokenDecryptError("malformed v1 envelope");
  }
  const [ivB64, tagB64, ctB64] = parts;
  try {
    const iv = Buffer.from(ivB64!, "base64url");
    const tag = Buffer.from(tagB64!, "base64url");
    const ct = Buffer.from(ctB64!, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", TOKEN_KEY, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch (e) {
    throw new TokenDecryptError(
      e instanceof Error ? e.message : "unknown cipher error",
    );
  }
}

/** Best-effort mask for display in the cockpit. Never throws. */
export function maskToken(stored: string | null): string {
  if (!stored) return "";
  let plain = "";
  try {
    plain = decryptToken(stored);
  } catch {
    return "•••• (unreadable)";
  }
  if (plain.length <= 6) return "******";
  return `••••${plain.slice(-4)}`;
}

// Back-compat aliases used by older callers; keep until callers are migrated.
export const obfuscateToken = encryptToken;
export const deobfuscateToken = decryptToken;

// ---------------------------------------------------------------------------
// Magic-link survey invite token hashing
// ---------------------------------------------------------------------------
// Tokens are issued as random 24-byte base64url strings, but only their hash
// is persisted. Lookup is by hash so a database leak does not expose live
// magic links.

export function hashInviteToken(token: string): string {
  // HMAC with the export key gives us a server-side pepper so even sha256
  // rainbow tables on the (high-entropy) token are useless.
  return createHmac("sha256", EXPORT_KEY).update(token).digest("hex");
}

export function safeEqHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Export signing (HMAC-SHA256)
// ---------------------------------------------------------------------------

export function signExportPayload(json: string): string {
  return createHmac("sha256", EXPORT_KEY).update(json).digest("hex");
}

export function verifyExportSignature(json: string, signature: string): boolean {
  const expected = signExportPayload(json);
  return safeEqHex(expected, signature);
}

// Stable, non-secret fingerprint so recipients can confirm which key was used
// to sign their bundle (does not reveal the key).
export function exportKeyFingerprint(): string {
  return createHash("sha256").update(EXPORT_KEY).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// SSRF guard for user-supplied connector base URLs
// ---------------------------------------------------------------------------

const PRIVATE_V4_PREFIXES: Array<[number, number]> = [
  // [start, mask-bits]
  [0x0a000000, 8],   // 10.0.0.0/8
  [0xac100000, 12],  // 172.16.0.0/12
  [0xc0a80000, 16],  // 192.168.0.0/16
  [0x7f000000, 8],   // 127.0.0.0/8 loopback
  [0xa9fe0000, 16],  // 169.254.0.0/16 link-local (incl. metadata 169.254.169.254)
  [0x64400000, 10],  // 100.64.0.0/10 carrier-grade NAT
  [0x00000000, 8],   // 0.0.0.0/8
  [0xe0000000, 4],   // 224.0.0.0/4 multicast
  [0xf0000000, 4],   // 240.0.0.0/4 reserved
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const x = Number(p);
    if (!Number.isInteger(x) || x < 0 || x > 255) return null;
    n = (n * 256 + x) >>> 0;
  }
  return n >>> 0;
}

function isPrivateV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  for (const [base, bits] of PRIVATE_V4_PREFIXES) {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((n & mask) === (base & mask)) return true;
  }
  return false;
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:aabb:ccdd) — re-check the v4 half.
  const dotted = /^::ffff:([0-9.]+)$/.exec(lower);
  if (dotted && dotted[1] && isPrivateV4(dotted[1])) return true;

  // Compare the first 16 bits to enforce true CIDR prefixes (not string
  // prefix matches, which miss e.g. fe90:: through febf:: in the
  // fe80::/10 range).
  const firstHextet = firstV6Hextet(lower);
  if (firstHextet === null) return false;
  // fe80::/10  → first 10 bits are 1111 1110 10xx xxxx → 0xfe80–0xfebf
  if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return true;
  // fc00::/7   → first 7 bits are 1111 110x → 0xfc00–0xfdff (ULA)
  if (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) return true;
  // ff00::/8   → multicast; not a routable destination for our connectors
  if (firstHextet >= 0xff00 && firstHextet <= 0xffff) return true;
  // ::ffff:0:0/96 mapped form parsed as plain v6 (not the dotted variant)
  // is rare; we already handle the dotted form above.
  return false;
}

function firstV6Hextet(ip: string): number | null {
  // Expand a leading "::" so the first group is always present.
  const head = ip.startsWith("::") ? ip.slice(2) : ip;
  const firstGroup = head.split(":", 1)[0] ?? "";
  if (!firstGroup) return 0; // pure "::"
  if (!/^[0-9a-f]{1,4}$/.test(firstGroup)) return null;
  return parseInt(firstGroup, 16);
}

export interface SsrfCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Synchronous URL safety check. Use at request validation time (POST/PATCH
 * for connector config) for fast feedback. Pair with `assertSafeUrlResolved`
 * at fetch time so DNS-resolved private IPs are also rejected.
 */
export function checkSafeUrl(raw: string): SsrfCheck {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "Invalid URL" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { ok: false, reason: `Scheme not allowed: ${u.protocol}` };
  }
  const host = u.hostname.toLowerCase();
  if (!host) return { ok: false, reason: "Missing host" };
  if (host === "localhost" || host === "ip6-localhost" || host.endsWith(".localhost")) {
    return { ok: false, reason: "Loopback host blocked" };
  }
  if (host.endsWith(".internal") || host.endsWith(".local")) {
    return { ok: false, reason: "Internal hostname blocked" };
  }
  // Block AWS/GCP metadata aliases by name as well.
  if (host === "metadata" || host === "metadata.google.internal") {
    return { ok: false, reason: "Metadata host blocked" };
  }
  const ipKind = isIP(host);
  if (ipKind === 4 && isPrivateV4(host)) {
    return { ok: false, reason: "Private IPv4 address blocked" };
  }
  if (ipKind === 6 && isPrivateV6(host)) {
    return { ok: false, reason: "Private IPv6 address blocked" };
  }
  return { ok: true };
}

/**
 * Fetch-time SSRF guard: validates the URL syntactically *and* resolves DNS,
 * rejecting if any returned address is private/reserved/loopback/link-local.
 * This closes the bypass where an attacker-controlled hostname resolves
 * directly to 169.254.169.254 (or another reserved range) at first lookup.
 *
 * Note: this does NOT defend against DNS rebinding (a second resolution
 * after our check returns a different answer used by `fetch`). Mitigating
 * that requires connecting via the resolved IP and pinning Host/SNI; we
 * recommend an egress proxy for production. See THREAT_MODEL.md.
 */
export async function assertSafeUrlResolved(raw: string): Promise<void> {
  const syntactic = checkSafeUrl(raw);
  if (!syntactic.ok) {
    throw new Error(`Refusing to call unsafe URL: ${syntactic.reason}`);
  }
  const u = new URL(raw);
  const host = u.hostname.toLowerCase();
  // If the host is already a literal IP, checkSafeUrl handled the range check.
  if (isIP(host)) return;
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch (e) {
    throw new Error(
      `Refusing to call unsafe URL: DNS lookup failed for ${host} (${
        e instanceof Error ? e.message : "unknown"
      })`,
    );
  }
  if (addresses.length === 0) {
    throw new Error(`Refusing to call unsafe URL: ${host} did not resolve`);
  }
  for (const a of addresses) {
    if (a.family === 4 && isPrivateV4(a.address)) {
      throw new Error(
        `Refusing to call unsafe URL: ${host} resolves to private IPv4 ${a.address}`,
      );
    }
    if (a.family === 6 && isPrivateV6(a.address)) {
      throw new Error(
        `Refusing to call unsafe URL: ${host} resolves to private IPv6 ${a.address}`,
      );
    }
  }
}
