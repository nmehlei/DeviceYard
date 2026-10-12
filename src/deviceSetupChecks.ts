/**
 * Device settings DeviceYard depends on but never changes on its own (spec
 * D-1: an admin applies a fix from the dashboard, and it lands in the device
 * event log).
 *
 * Both were found on 2026-10-02 on the farm's Galaxy S10:
 *   * adb_allowed_connection_time unset = Android's 7-day expiry of an
 *     "Always allow" USB debugging grant. After a reboot the device came back
 *     `unauthorized` and needed someone in the room.
 *   * verifier_verify_adb_installs unset = Play Protect verifies every adb
 *     install, and for an unrecognised debug build that verification is
 *     suspected of blocking on an on-screen prompt until the job times out.
 *
 * See docs/superpowers/specs/2026-10-02-device-setup-checks-design.md.
 */

export interface DeviceSetupCheck {
  /** Stable and URL-safe: it is a path segment of the fix route. */
  id: string;
  title: string;
  /** One sentence: what goes wrong if this is not fixed. */
  detail: string;
  /** `adb shell` argv that prints the current value. */
  readArgs: readonly string[];
  isOk(output: string): boolean;
  /** `adb shell` argv that applies the fix. */
  fixArgs: readonly string[];
}

export interface SetupCheckResult {
  id: string;
  title: string;
  detail: string;
  /** null = could not be read (device not online, read failed). Never a warning. */
  ok: boolean | null;
}

// `settings get` prints the literal "null" for an unset value, which here
// means the Android default - exactly the behaviour these checks exist to
// turn off. Only an explicit 0 is ok.
const isZero = (output: string) => output.trim() === "0";

export const SETUP_CHECKS: readonly DeviceSetupCheck[] = [
  {
    id: "adb-auth-timeout",
    title: "USB debugging approval expires",
    detail:
      "The device forgets this host's USB debugging approval after 7 days; after a reboot someone must accept the prompt on the device again.",
    readArgs: ["settings", "get", "global", "adb_allowed_connection_time"],
    isOk: isZero,
    fixArgs: ["settings", "put", "global", "adb_allowed_connection_time", "0"],
  },
  {
    // Deliberately the narrow "Verify apps over USB" switch, not Play Protect
    // as a whole (package_verifier_enable): only installs pushed by the farm
    // host skip the check.
    id: "adb-install-verification",
    title: "Play Protect verifies adb installs",
    detail:
      "Play Protect may stop an install from this host to show a prompt on the device, hanging the job until it times out.",
    readArgs: ["settings", "get", "global", "verifier_verify_adb_installs"],
    isOk: isZero,
    fixArgs: ["settings", "put", "global", "verifier_verify_adb_installs", "0"],
  },
];

const MARKER = /^__DY_CHECK_(.+)__$/;
// What `settings get global` actually prints: a number, or "null" when unset.
// Anything else is error text that adb merged into stdout (no shell v2
// protocol) - a failed read, not a reading.
const SETTING_VALUE = /^(null|-?\d+)$/;
const markerFor = (id: string) => `__DY_CHECK_${id}__`;

export function findSetupCheck(id: string): DeviceSetupCheck | undefined {
  return SETUP_CHECKS.find((check) => check.id === id);
}

export function checkResult(check: DeviceSetupCheck, ok: boolean | null): SetupCheckResult {
  return { id: check.id, title: check.title, detail: check.detail, ok };
}

export function unknownSetupChecks(checks: readonly DeviceSetupCheck[] = SETUP_CHECKS): SetupCheckResult[] {
  return checks.map((check) => checkResult(check, null));
}

/**
 * One `adb shell` invocation that prints the model and then every check's
 * value behind a marker line, so the device list costs one adb process per
 * device - the same as the getprop call it replaces.
 *
 * Separate argv tokens with ";" tokens between commands: adb joins them with
 * spaces and the device shell runs the result (verified on the S10). Keeping
 * "getprop" as its own token also keeps every existing fake runner that
 * matches `args.includes("getprop")` answering with a bare model.
 */
export function buildProbeArgs(checks: readonly DeviceSetupCheck[] = SETUP_CHECKS): string[] {
  const args = ["getprop", "ro.product.model"];
  for (const check of checks) args.push(";", "echo", markerFor(check.id), ";", ...check.readArgs);
  return args;
}

export function parseProbeOutput(
  stdout: string,
  checks: readonly DeviceSetupCheck[] = SETUP_CHECKS
): { model?: string; checks: SetupCheckResult[] } {
  const modelLines: string[] = [];
  const sections = new Map<string, string[]>();
  let current: string[] = modelLines;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    const marker = MARKER.exec(line);
    if (marker) {
      current = [];
      sections.set(marker[1], current);
      continue;
    }
    current.push(line);
  }

  const model = modelLines.find((line) => line.length > 0);
  return {
    model,
    checks: checks.map((check) => {
      const value = sections.get(check.id)?.join("\n").trim();
      // Missing marker, empty section or error text: the read failed, not
      // the setting - never a warning.
      if (!value || !SETTING_VALUE.test(value)) return checkResult(check, null);
      return checkResult(check, check.isOk(value));
    }),
  };
}
