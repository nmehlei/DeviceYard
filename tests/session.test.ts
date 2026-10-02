import crypto from "crypto";
import { signSession, verifySession, SESSION_TTL_MS } from "../src/session";

const SECRET = "a-long-random-secret";

function signRawPayload(json: string, secret: string): string {
  const payload = Buffer.from(json).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

test("a signed session round-trips to its userId", () => {
  const value = signSession(42, Date.now() + SESSION_TTL_MS, SECRET);
  expect(verifySession(value, SECRET)).toBe(42);
});

test("a tampered payload is rejected", () => {
  const value = signSession(42, Date.now() + SESSION_TTL_MS, SECRET);
  const [payload, signature] = value.split(".");
  const forged = Buffer.from(JSON.stringify({ userId: 999, exp: Date.now() + 1000 })).toString("base64url");

  expect(verifySession(`${forged}.${signature}`, SECRET)).toBeUndefined();
  expect(verifySession(`${payload}.deadbeef`, SECRET)).toBeUndefined();
});

test("a session signed with another secret is rejected - rotating the secret revokes everything", () => {
  const value = signSession(42, Date.now() + SESSION_TTL_MS, SECRET);
  expect(verifySession(value, "a-different-secret")).toBeUndefined();
});

test("an expired session is rejected", () => {
  const value = signSession(42, 1000, SECRET);
  expect(verifySession(value, SECRET, 2000)).toBeUndefined();
});

test("malformed values are rejected without throwing", () => {
  expect(verifySession(undefined, SECRET)).toBeUndefined();
  expect(verifySession("", SECRET)).toBeUndefined();
  expect(verifySession("not-a-session", SECRET)).toBeUndefined();
  expect(verifySession("missing-a-dot-separator", SECRET)).toBeUndefined();
});

test("a userId that is not a number in the payload is rejected", () => {
  const value = signRawPayload(JSON.stringify({ userId: "42", exp: Date.now() + SESSION_TTL_MS }), SECRET);
  expect(verifySession(value, SECRET)).toBeUndefined();
});

test("an exp claiming to be further in the future than SESSION_TTL_MS allows is rejected", () => {
  const value = signRawPayload(JSON.stringify({ userId: 42, exp: Date.now() + SESSION_TTL_MS * 100 }), SECRET);
  expect(verifySession(value, SECRET)).toBeUndefined();
});
