import type { CommandRunner } from "./maestro";
import { defaultRunner } from "./maestro";
import type { ResetPolicy } from "./store/rows";

/**
 * Vendor apps known to interrupt a run with a full-screen dialog. Force-stopped
 * before every job. Stopping one that is not installed is harmless — adb
 * returns non-zero and it is recorded as a warning, never fatal.
 */
export const NUISANCE_PACKAGES = [
  "com.osp.app.signin", // Samsung account — "account policies updated"
  "com.samsung.android.scloud", // Samsung Cloud sync prompts
  "com.sec.android.app.samsungapps", // Galaxy Store update nags
];

/**
 * The package that serves Custom Tabs, resolved rather than hardcoded.
 *
 * Apple and Facebook keep their sessions in this browser's cookie jar - the
 * Facebook app is not installed on the farm handset, so its SDK falls back to
 * a Custom Tab - and the default handler is device state that can change. A
 * hardcoded `com.android.chrome` would silently clear the wrong thing, or
 * nothing, the day it does.
 *
 * Returns undefined when the resolution produces nothing usable, so the
 * caller warns instead of running `pm clear` against a garbage package name.
 */
export function parseResolvedBrowser(stdout: string): string | undefined {
  // `cmd package resolve-activity --brief` prints the component as
  // "<package>/<activity>" on its own line, after a priority header line.
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    const slash = trimmed.indexOf("/");
    if (slash <= 0) continue;
    const pkg = trimmed.slice(0, slash);
    // A package name, not a header, a path or an error string.
    if (/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/.test(pkg)) return pkg;
  }
  return undefined;
}

export interface PrepareResult {
  /** False means the job must not proceed — the device is unusable. */
  ready: boolean;
  /** Why the device is unusable. Only set when ready is false. */
  reason?: string;
  /** Cleanup steps that failed but are not fatal. */
  warnings: string[];
}

/**
 * Bring the device to a known state before a job runs.
 *
 * Every failure this guards against was observed on the real device farm:
 *   * the phone silently dropped off USB, so flows ran against nothing
 *   * a Samsung "account policies updated" dialog covered the screen mid-run
 *   * leftover app state meant the tutorial was already dismissed
 *
 * Readiness is fatal; individual cleanup steps are not. A device that is
 * missing or unauthorized cannot run anything, so we fail fast with a clear
 * reason rather than letting Maestro produce a confusing element-not-found.
 * A cleanup step that fails (some OEM builds refuse `pm clear` for apps with
 * device-admin hooks) only degrades isolation, so it is recorded and the job
 * continues.
 */
export async function prepareDevice(
  deviceId: string,
  appId: string,
  runner: CommandRunner = defaultRunner,
  // Defaults to the weakest policy on purpose: a caller that has not been
  // taught about reset policies must never start deleting a device owner's
  // browsing data because it forgot an argument.
  resetPolicy: ResetPolicy = "app-only",
  // Isolated jobs run in a disposable work profile, so the primary user's app data is not theirs to clear.
  isolated = false
): Promise<PrepareResult> {
  const adb = (...args: string[]) => runner("adb", ["-s", deviceId, ...args]);
  const warnings: string[] = [];

  // --- Readiness: fatal ------------------------------------------------------
  const { stdout } = await adb("devices");
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith(deviceId));

  if (!line) {
    return {
      ready: false,
      reason:
        `device ${deviceId} is not present in \`adb devices\`. It has most likely ` +
        `dropped off USB — check the passthrough on the Proxmox host.`,
      warnings,
    };
  }

  const state = line.split(/\s+/)[1] ?? "unknown";
  if (state !== "device") {
    return {
      ready: false,
      reason:
        `device ${deviceId} is in state "${state}", not "device". ` +
        (state === "unauthorized"
          ? "Accept the USB debugging prompt on the phone."
          : "The device is attached but not usable."),
      warnings,
    };
  }

  // --- Cleanup: best-effort --------------------------------------------------
  // Ordered so the screen is usable before we try to dismiss anything on it.
  const steps: Array<{ what: string; args: string[] }> = [
    // Suppress crash/ANR dialogs for the rest of the session.
    { what: "suppress error dialogs", args: ["shell", "settings", "put", "global", "hide_error_dialogs", "1"] },
    // Wake and unlock — a slept or locked screen fails every tap silently.
    { what: "wake screen", args: ["shell", "input", "keyevent", "KEYCODE_WAKEUP"] },
    { what: "dismiss keyguard", args: ["shell", "wm", "dismiss-keyguard"] },
    // An earlier job's flow can leave the phone in airplane mode, which
    // silently kills every network call of the next one.
    { what: "disable airplane mode", args: ["shell", "cmd", "connectivity", "airplane-mode", "disable"] },
    // Dismiss whatever system dialog is on top (Samsung policy nags and similar).
    { what: "dismiss dialogs (back)", args: ["shell", "input", "keyevent", "KEYCODE_BACK"] },
    { what: "dismiss dialogs (back)", args: ["shell", "input", "keyevent", "KEYCODE_BACK"] },
    // Cold start: no leftover state, no cached auth, tutorial shown again.
    { what: "force-stop app", args: ["shell", "am", "force-stop", appId] },
    // Vendor apps that put a full-screen dialog over whatever is running. The
    // Samsung account "policies updated" screen did exactly that mid-flow and
    // failed a run that had nothing to do with it, so stop them up front
    // rather than hope they stay quiet.
    ...NUISANCE_PACKAGES.map((pkg) => ({
      what: `force-stop ${pkg}`,
      args: ["shell", "am", "force-stop", pkg],
    })),
    ...(isolated ? [] : [{ what: "clear app data", args: ["shell", "pm", "clear", appId] }]),
  ];

  for (const step of steps) {
    const { code, stderr } = await adb(...step.args);
    if (code !== 0) {
      warnings.push(`${step.what} failed (exit ${code})${stderr ? `: ${stderr.trim()}` : ""}`);
    }
  }

  // Deliberately after the loop, so a browser problem can never mask a
  // failure to reset the app under test - that one matters more, and a
  // warning list that leads with the browser buries it.
  if (resetPolicy === "app-and-browser") {
    warnings.push(...(await clearBrowser(adb)));
  }

  return { ready: true, warnings };
}

/**
 * Clears the Custom Tabs browser, which is where the Apple and Facebook login
 * sessions live. Best-effort like every other cleanup step: a device that
 * will not give up its browser still runs the job.
 *
 * Only reached under the `app-and-browser` policy, which is destructive on a
 * handset holding real browsing data and is therefore never the default.
 */
async function clearBrowser(
  adb: (...args: string[]) => ReturnType<CommandRunner>
): Promise<string[]> {
  const warnings: string[] = [];

  const resolved = await adb(
    "shell",
    "cmd",
    "package",
    "resolve-activity",
    "--brief",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    "https://example.com"
  );
  if (resolved.code !== 0) {
    warnings.push(`resolve default browser failed (exit ${resolved.code})`);
    return warnings;
  }

  const pkg = parseResolvedBrowser(resolved.stdout);
  if (!pkg) {
    warnings.push("resolve default browser found no package - browser not cleared");
    return warnings;
  }

  // Named in the warning list on success too: which browser got wiped is the
  // one thing an operator needs to see when this misfires.
  const cleared = await adb("shell", "pm", "clear", pkg);
  if (cleared.code !== 0) {
    warnings.push(`clear browser ${pkg} failed (exit ${cleared.code})`);
  } else {
    warnings.push(`cleared browser data for ${pkg}`);
  }
  return warnings;
}
