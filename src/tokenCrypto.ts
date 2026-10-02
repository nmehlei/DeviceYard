import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

/** The raw value handed to an operator to paste into CI - never logged,
 * never returned except at creation time and on an explicit "list tokens"
 * call by an org member (see the spec's "token storage" decision: viewable,
 * not shown-once). */
export function generateToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/** SHA-256 hex digest, used as an indexed lookup key so the CI bearer-auth
 * path can find the matching row with `WHERE token_hash = ?` instead of
 * decrypting every row in the table on every request. */
export function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

/** keyHex must be a 64-character hex string (32 bytes) - TOKEN_ENCRYPTION_KEY,
 * validated at config load time in src/config.ts (Task 5). */
export function encryptToken(rawToken: string, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(rawToken, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("hex"), authTag.toString("hex"), encrypted.toString("hex")].join(":");
}

export function decryptToken(stored: string, keyHex: string): string {
  const [ivHex, authTagHex, dataHex] = stored.split(":");
  const key = Buffer.from(keyHex, "hex");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const data = Buffer.from(dataHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
