import { redactAttributes, redactText } from "../../src/telemetry/redact";
import { REDACTED } from "../../src/env";

test("a secret-named attribute keeps its key and loses its value", () => {
  const out = redactAttributes({ "env.API_TOKEN": "s3cr3t-value", "env.LAUNCHER": "samsung" });
  expect(out["env.API_TOKEN"]).toBe(REDACTED);
  expect(out["env.LAUNCHER"]).toBe("samsung");
});

test("the marker match is case-insensitive and substring-based", () => {
  const out = redactAttributes({
    my_password_field: "hunter2",
    "Some.Secret.Thing": "abc",
    apikey: "xyz",
  });
  expect(out["my_password_field"]).toBe(REDACTED);
  expect(out["Some.Secret.Thing"]).toBe(REDACTED);
  expect(out["apikey"]).toBe(REDACTED);
});

test("authorization and cookie attributes are redacted", () => {
  const out = redactAttributes({
    "http.request.header.authorization": "Bearer abc123",
    "http.request.header.cookie": "sid=abc",
  });
  expect(out["http.request.header.authorization"]).toBe(REDACTED);
  expect(out["http.request.header.cookie"]).toBe(REDACTED);
});

test("non-string values under a secret-named key are still redacted", () => {
  const out = redactAttributes({ "db.password": 12345 });
  expect(out["db.password"]).toBe(REDACTED);
});

test("ordinary attributes pass through untouched", () => {
  const attrs = { "job.id": "j-1", "flow.index": 3, "job.ok": true };
  expect(redactAttributes(attrs)).toEqual(attrs);
});

test("redactText masks secret env values appearing in free text", () => {
  const text = "maestro failed: login used hunter2 and it was wrong";
  expect(redactText(text, { E2E_PASSWORD: "hunter2" })).not.toContain("hunter2");
});

test("redactText leaves text alone when there are no secrets", () => {
  expect(redactText("plain failure", { LAUNCHER: "samsung" })).toBe("plain failure");
});

test("redactText tolerates an absent env map", () => {
  expect(redactText("plain failure")).toBe("plain failure");
});
