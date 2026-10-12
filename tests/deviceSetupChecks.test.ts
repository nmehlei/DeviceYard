import {
  SETUP_CHECKS,
  buildProbeArgs,
  findSetupCheck,
  parseProbeOutput,
  unknownSetupChecks,
} from "../src/deviceSetupChecks";

// Captured from the farm's Galaxy S10 on 2026-10-03 with both settings fixed.
const REAL_OK_OUTPUT =
  "SM-G973F\n__DY_CHECK_adb-auth-timeout__\n0\n__DY_CHECK_adb-install-verification__\n0\n";

const byId = (results: { id: string; ok: boolean | null }[]) =>
  Object.fromEntries(results.map((r) => [r.id, r.ok]));

test("registers exactly the two checks the spec names", () => {
  expect(SETUP_CHECKS.map((c) => c.id)).toEqual(["adb-auth-timeout", "adb-install-verification"]);
});

test("never touches Play Protect as a whole", () => {
  const everyArg = SETUP_CHECKS.flatMap((c) => [...c.readArgs, ...c.fixArgs]);
  expect(everyArg).not.toContain("package_verifier_enable");
});

test("the probe reads the model first, then each check behind its marker, as separate argv tokens", () => {
  expect(buildProbeArgs()).toEqual([
    "getprop", "ro.product.model",
    ";", "echo", "__DY_CHECK_adb-auth-timeout__",
    ";", "settings", "get", "global", "adb_allowed_connection_time",
    ";", "echo", "__DY_CHECK_adb-install-verification__",
    ";", "settings", "get", "global", "verifier_verify_adb_installs",
  ]);
});

test("real device output with both settings fixed parses as ok", () => {
  const parsed = parseProbeOutput(REAL_OK_OUTPUT);
  expect(parsed.model).toBe("SM-G973F");
  expect(byId(parsed.checks)).toEqual({ "adb-auth-timeout": true, "adb-install-verification": true });
});

test("an unset setting reads as the literal null and is NOT ok", () => {
  const parsed = parseProbeOutput(
    "SM-G973F\n__DY_CHECK_adb-auth-timeout__\nnull\n__DY_CHECK_adb-install-verification__\nnull\n"
  );
  expect(byId(parsed.checks)).toEqual({ "adb-auth-timeout": false, "adb-install-verification": false });
});

test("the 7-day default timeout written out explicitly is not ok", () => {
  const parsed = parseProbeOutput("X\n__DY_CHECK_adb-auth-timeout__\n604800000\n__DY_CHECK_adb-install-verification__\n0\n");
  expect(byId(parsed.checks)).toEqual({ "adb-auth-timeout": false, "adb-install-verification": true });
});

test("an empty section means the read failed - unknown, never a warning", () => {
  const parsed = parseProbeOutput("X\n__DY_CHECK_adb-auth-timeout__\n\n__DY_CHECK_adb-install-verification__\n0\n");
  expect(byId(parsed.checks)).toEqual({ "adb-auth-timeout": null, "adb-install-verification": true });
});

test("output with no markers keeps the model and leaves every check unknown", () => {
  const parsed = parseProbeOutput("Pixel 7\n");
  expect(parsed.model).toBe("Pixel 7");
  expect(byId(parsed.checks)).toEqual({ "adb-auth-timeout": null, "adb-install-verification": null });
});

test("CRLF line endings from older adb clients parse the same", () => {
  const parsed = parseProbeOutput(REAL_OK_OUTPUT.replace(/\n/g, "\r\n"));
  expect(parsed.model).toBe("SM-G973F");
  expect(byId(parsed.checks)).toEqual({ "adb-auth-timeout": true, "adb-install-verification": true });
});

test("empty output yields no model", () => {
  expect(parseProbeOutput("").model).toBeUndefined();
});

test("results carry title and detail so the dashboard needs no copy of its own", () => {
  const [first] = unknownSetupChecks();
  expect(first).toEqual({
    id: "adb-auth-timeout",
    title: SETUP_CHECKS[0].title,
    detail: SETUP_CHECKS[0].detail,
    ok: null,
  });
});

test("findSetupCheck resolves known ids only", () => {
  expect(findSetupCheck("adb-install-verification")?.fixArgs).toEqual([
    "settings", "put", "global", "verifier_verify_adb_installs", "0",
  ]);
  expect(findSetupCheck("nope")).toBeUndefined();
});

test("error text instead of a value is unknown, not a warning", () => {
  // Without the shell v2 protocol adb merges stderr into stdout, so a missing
  // or failing `settings` binary lands in the section as text.
  const parsed = parseProbeOutput(
    "X\n__DY_CHECK_adb-auth-timeout__\n/system/bin/sh: settings: not found\n__DY_CHECK_adb-install-verification__\nnull\n"
  );
  expect(byId(parsed.checks)).toEqual({ "adb-auth-timeout": null, "adb-install-verification": false });
});
