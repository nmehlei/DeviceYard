import { hashPassword, verifyPassword } from "../src/passwords";

test("a password verifies against its own hash", () => {
  const hash = hashPassword("correct horse battery staple");
  expect(verifyPassword("correct horse battery staple", hash)).toBe(true);
});

test("the wrong password is rejected", () => {
  const hash = hashPassword("correct horse battery staple");
  expect(verifyPassword("wrong password", hash)).toBe(false);
});

test("two hashes of the same password are different (random salt)", () => {
  const a = hashPassword("same password");
  const b = hashPassword("same password");
  expect(a).not.toBe(b);
  expect(verifyPassword("same password", a)).toBe(true);
  expect(verifyPassword("same password", b)).toBe(true);
});

test("a garbage stored value is rejected without throwing", () => {
  expect(verifyPassword("anything", "not-a-real-hash")).toBe(false);
  expect(verifyPassword("anything", "")).toBe(false);
});
