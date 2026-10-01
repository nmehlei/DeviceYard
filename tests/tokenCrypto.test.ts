import { generateToken, hashToken, encryptToken, decryptToken } from "../src/tokenCrypto";

const KEY = "0".repeat(64); // 32 bytes hex - a valid AES-256 key for tests

test("generateToken produces a unique, url-safe string each time", () => {
  const a = generateToken();
  const b = generateToken();
  expect(a).not.toBe(b);
  expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(a.length).toBeGreaterThan(20);
});

test("hashToken is deterministic - the same input always hashes the same", () => {
  const token = generateToken();
  expect(hashToken(token)).toBe(hashToken(token));
});

test("hashToken produces different output for different tokens", () => {
  expect(hashToken("token-a")).not.toBe(hashToken("token-b"));
});

test("encryptToken then decryptToken round-trips to the original value", () => {
  const raw = "my-secret-ci-token-value";
  const encrypted = encryptToken(raw, KEY);
  expect(encrypted).not.toContain(raw);
  expect(decryptToken(encrypted, KEY)).toBe(raw);
});

test("decrypting with the wrong key throws rather than returning garbage silently", () => {
  const encrypted = encryptToken("secret", KEY);
  const wrongKey = "1".repeat(64);
  expect(() => decryptToken(encrypted, wrongKey)).toThrow();
});

test("two encryptions of the same value produce different ciphertext (random IV)", () => {
  const a = encryptToken("same-value", KEY);
  const b = encryptToken("same-value", KEY);
  expect(a).not.toBe(b);
  expect(decryptToken(a, KEY)).toBe("same-value");
  expect(decryptToken(b, KEY)).toBe("same-value");
});
