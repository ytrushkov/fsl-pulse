import { randomBytes, createHash } from "node:crypto";

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

// Extremely lightweight token "encryption" placeholder. Replace with KMS in prod.
export function obfuscateToken(plain: string): string {
  return Buffer.from(plain, "utf8").toString("base64");
}

export function deobfuscateToken(stored: string): string {
  return Buffer.from(stored, "base64").toString("utf8");
}

export function maskToken(stored: string | null): string {
  if (!stored) return "";
  const plain = deobfuscateToken(stored);
  if (plain.length <= 6) return "******";
  return `••••${plain.slice(-4)}`;
}
