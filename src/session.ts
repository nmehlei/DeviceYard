import crypto from "crypto";

export const SESSION_COOKIE = "mdf_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * A signed cookie identifying a user, not a sessions table: rotating
 * SESSION_SECRET is an acceptable revocation mechanism for a farm this
 * size. Carries userId only - which org is "active" is resolved per-request
 * from an X-Org-Id header instead (see src/auth.ts), not baked in here, so
 * switching orgs never requires re-signing this cookie.
 */
function sign(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signSession(userId: number, expiresAt: number, secret: string, version = 0): string {
  const payload = Buffer.from(JSON.stringify({ userId, exp: expiresAt, version })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySession(
  value: string | undefined,
  secret: string,
  now: number = Date.now(),
  currentVersion?: (userId: number) => number | undefined
): number | undefined {
  if (!value) return undefined;

  const [payload, signature] = value.split(".");
  if (!payload || !signature) return undefined;

  const expected = sign(payload, secret);
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return undefined;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      userId?: unknown;
      exp?: unknown;
      version?: unknown;
    };
    if (typeof claims.userId !== "number" || typeof claims.exp !== "number") return undefined;
    if (claims.exp <= now) return undefined;
    if (!(claims.exp - now <= SESSION_TTL_MS)) return undefined;
    const version = claims.version ?? 0;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) return undefined;
    if (currentVersion && currentVersion(claims.userId) !== version) return undefined;
    return claims.userId;
  } catch {
    return undefined;
  }
}
