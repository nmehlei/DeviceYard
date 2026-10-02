import crypto from "crypto";

// scryptSync, not bcrypt: this repo deliberately has no native module
// dependencies (node:sqlite was picked over better-sqlite3 for the same
// reason - see docs/superpowers/notes/2026-08-16-environment-findings.md).
// scrypt is built into Node's crypto module and memory-hard, same class of
// guarantee bcrypt/argon2 give against brute-forcing a stolen hash.
const KEY_LENGTH = 64;

// Single source of truth for both admin-driven and self-service password
// changes (api/admin.ts, api/session.ts) - a value chosen in one place and
// duplicated in the other is exactly how the two drift apart.
export const MIN_PASSWORD_LENGTH = 8;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, KEY_LENGTH);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (expected.length !== KEY_LENGTH) return false;

  const actual = crypto.scryptSync(password, salt, KEY_LENGTH);
  return crypto.timingSafeEqual(actual, expected);
}
