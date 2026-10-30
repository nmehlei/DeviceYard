import { prepareDevice, type PrepareResult } from "../src/device";
import type { CommandRunner } from "../src/maestro";

const DEVICE = "RF8M40H8RFP";
const APP = "net.donable.app.testing";

/** Records every adb invocation so tests can assert on the sequence. */
function recordingRunner(
  overrides: (file: string, args: string[]) => { code: number; stdout: string; stderr: string } | undefined = () =>
    undefined
): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CommandRunner = async (file, args) => {
    calls.push([file, ...args]);
    return overrides(file, args) ?? { code: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

/** `adb devices` output for a device in the given state. */
function devicesOutput(state: string): string {
  return `List of devices attached\n${DEVICE}\t${state}\n`;
}

function isDevicesQuery(args: string[]): boolean {
  return args.includes("devices");
}

test("fails fast when the device is not present at all", async () => {
  const { runner } = recordingRunner((_f, args) =>
    isDevicesQuery(args) ? { code: 0, stdout: "List of devices attached\n", stderr: "" } : undefined
  );

  const result: PrepareResult = await prepareDevice(DEVICE, APP, runner);

  expect(result.ready).toBe(false);
  expect(result.reason).toMatch(/not (present|visible)/i);
});

test("fails fast when the device is present but unauthorized", async () => {
  const { runner } = recordingRunner((_f, args) =>
    isDevicesQuery(args) ? { code: 0, stdout: devicesOutput("unauthorized"), stderr: "" } : undefined
  );

  const result = await prepareDevice(DEVICE, APP, runner);

  expect(result.ready).toBe(false);
  expect(result.reason).toMatch(/unauthorized/i);
});

test("does not attempt any cleanup when the device is unusable", async () => {
  const { runner, calls } = recordingRunner((_f, args) =>
    isDevicesQuery(args) ? { code: 0, stdout: devicesOutput("offline"), stderr: "" } : undefined
  );

  await prepareDevice(DEVICE, APP, runner);

  // Only the readiness probe should have run — no force-stop, no pm clear.
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual(["adb", "-s", DEVICE, "devices"]);
});

test("reports ready and performs the cleanup sequence on a healthy device", async () => {
  const { runner, calls } = recordingRunner((_f, args) =>
    isDevicesQuery(args) ? { code: 0, stdout: devicesOutput("device"), stderr: "" } : undefined
  );

  const result = await prepareDevice(DEVICE, APP, runner);

  expect(result.ready).toBe(true);

  const flat = calls.map((c) => c.join(" "));
  // Cold start: the app under test must not carry state between jobs.
  expect(flat).toContainEqual(expect.stringContaining(`am force-stop ${APP}`));
  expect(flat).toContainEqual(expect.stringContaining(`pm clear ${APP}`));
  // System dialogs (Samsung "policies updated", crash/ANR popups) sit on top of
  // the app and silently break every subsequent tap.
  expect(flat).toContainEqual(expect.stringContaining("hide_error_dialogs 1"));
  expect(flat).toContainEqual(expect.stringContaining("KEYCODE_BACK"));
  // A slept or locked screen fails every tap without an obvious error.
  expect(flat).toContainEqual(expect.stringContaining("KEYCODE_WAKEUP"));
});

test("every adb command targets the requested device", async () => {
  const { runner, calls } = recordingRunner((_f, args) =>
    isDevicesQuery(args) ? { code: 0, stdout: devicesOutput("device"), stderr: "" } : undefined
  );

  await prepareDevice(DEVICE, APP, runner);

  for (const call of calls) {
    expect(call.slice(0, 3)).toEqual(["adb", "-s", DEVICE]);
  }
});

test("a failing cleanup step does not block the job", async () => {
  // pm clear fails on some OEM builds for apps with device-admin hooks. That is
  // not a reason to fail the whole run — the app still gets force-stopped.
  const { runner } = recordingRunner((_f, args) => {
    if (isDevicesQuery(args)) return { code: 0, stdout: devicesOutput("device"), stderr: "" };
    if (args.includes("clear")) return { code: 1, stdout: "", stderr: "Failed" };
    return undefined;
  });

  const result = await prepareDevice(DEVICE, APP, runner);

  expect(result.ready).toBe(true);
  expect(result.warnings.some((w) => /clear/i.test(w))).toBe(true);
});

test("an isolated preparation does not clear the primary user's app data", async () => {
  const { runner, calls } = recordingRunner((_f, args) =>
    isDevicesQuery(args) ? { code: 0, stdout: devicesOutput("device"), stderr: "" } : undefined
  );

  const result = await prepareDevice(DEVICE, APP, runner, "app-only", true);

  expect(result.ready).toBe(true);
  const flat = calls.map((c) => c.join(" "));
  expect(flat.some((c) => c.includes("pm clear"))).toBe(false);
  expect(flat).toContainEqual(expect.stringContaining(`am force-stop ${APP}`));
});

test("every preparation disables airplane mode, and a failure is only a warning", async () => {
  const { runner, calls } = recordingRunner((_f, args) => {
    if (isDevicesQuery(args)) return { code: 0, stdout: devicesOutput("device"), stderr: "" };
    if (args.includes("airplane-mode")) return { code: 1, stdout: "", stderr: "nope" };
    return undefined;
  });

  const result = await prepareDevice(DEVICE, APP, runner);

  expect(result.ready).toBe(true);
  expect(calls).toContainEqual(["adb", "-s", DEVICE, "shell", "cmd", "connectivity", "airplane-mode", "disable"]);
  expect(result.warnings.some((w) => w.startsWith("disable airplane mode failed"))).toBe(true);
});
