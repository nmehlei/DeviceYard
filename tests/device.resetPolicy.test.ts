import { parseResolvedBrowser, prepareDevice } from "../src/device";
import type { CommandRunner } from "../src/maestro";

const DEVICE = "RF8M40H8RFP";
const APP = "net.donable.app.testing";

/** What `cmd package resolve-activity --brief` actually prints on the farm's
 * Galaxy S10, captured 2026-09-17. */
const RESOLVE_OUTPUT = "priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\ncom.android.chrome/com.google.android.apps.chrome.IntentDispatcher\n";

function recordingRunner(
  overrides: (file: string, args: string[]) => { code: number; stdout: string; stderr: string } | undefined = () =>
    undefined
): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CommandRunner = async (file, args) => {
    calls.push([file, ...args]);
    if (args.includes("devices")) {
      return { code: 0, stdout: `List of devices attached\n${DEVICE}\tdevice\n`, stderr: "" };
    }
    if (args.includes("resolve-activity")) {
      return overrides(file, args) ?? { code: 0, stdout: RESOLVE_OUTPUT, stderr: "" };
    }
    return overrides(file, args) ?? { code: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

const joined = (calls: string[][]) => calls.map((c) => c.join(" "));

describe("parseResolvedBrowser", () => {
  test("takes the package from the component line, not the priority header", () => {
    expect(parseResolvedBrowser(RESOLVE_OUTPUT)).toBe("com.android.chrome");
  });

  test("returns undefined when resolution found nothing", () => {
    expect(parseResolvedBrowser("No activity found\n")).toBeUndefined();
    expect(parseResolvedBrowser("")).toBeUndefined();
  });

  test("rejects a line that is a path rather than a component", () => {
    // A bare path would otherwise parse as package "" or "/data", and get
    // handed to `pm clear`.
    expect(parseResolvedBrowser("/data/app/whatever\n")).toBeUndefined();
  });
});

describe("app-only (the default)", () => {
  test("never resolves or clears a browser", async () => {
    const { runner, calls } = recordingRunner();

    await prepareDevice(DEVICE, APP, runner, "app-only");

    expect(joined(calls).some((c) => c.includes("resolve-activity"))).toBe(false);
    expect(joined(calls).some((c) => c.includes("pm clear com.android.chrome"))).toBe(false);
  });

  test("is what an omitted argument selects", async () => {
    const { runner, calls } = recordingRunner();

    await prepareDevice(DEVICE, APP, runner);

    expect(joined(calls).some((c) => c.includes("resolve-activity"))).toBe(false);
  });
});

describe("app-and-browser", () => {
  test("clears the resolved browser, after the app under test", async () => {
    const { runner, calls } = recordingRunner();

    const result = await prepareDevice(DEVICE, APP, runner, "app-and-browser");

    const seq = joined(calls);
    const appClear = seq.findIndex((c) => c.includes(`pm clear ${APP}`));
    const browserClear = seq.findIndex((c) => c.includes("pm clear com.android.chrome"));

    expect(appClear).toBeGreaterThanOrEqual(0);
    expect(browserClear).toBeGreaterThan(appClear);
    expect(result.ready).toBe(true);
    expect(result.warnings).toContain("cleared browser data for com.android.chrome");
  });

  test("warns and clears nothing when resolution yields no package", async () => {
    const { runner, calls } = recordingRunner((_f, args) =>
      args.includes("resolve-activity") ? { code: 0, stdout: "No activity found\n", stderr: "" } : undefined
    );

    const result = await prepareDevice(DEVICE, APP, runner, "app-and-browser");

    expect(joined(calls).some((c) => c.startsWith(`adb -s ${DEVICE} shell pm clear com.`) && !c.includes(APP))).toBe(
      false
    );
    expect(result.warnings.some((w) => /no package/i.test(w))).toBe(true);
  });

  test("warns and clears nothing when resolution itself fails", async () => {
    const { runner, calls } = recordingRunner((_f, args) =>
      args.includes("resolve-activity") ? { code: 1, stdout: "", stderr: "boom" } : undefined
    );

    const result = await prepareDevice(DEVICE, APP, runner, "app-and-browser");

    expect(joined(calls).some((c) => c.includes("pm clear com.android.chrome"))).toBe(false);
    expect(result.warnings.some((w) => /resolve default browser failed/i.test(w))).toBe(true);
  });

  test("a refused browser clear warns but still runs the job", async () => {
    const { runner } = recordingRunner((_f, args) =>
      args.includes("clear") && args.includes("com.android.chrome")
        ? { code: 255, stdout: "", stderr: "Failed" }
        : undefined
    );

    const result = await prepareDevice(DEVICE, APP, runner, "app-and-browser");

    expect(result.ready).toBe(true);
    expect(result.warnings.some((w) => /clear browser com\.android\.chrome failed/i.test(w))).toBe(true);
  });

  test("a device that is not ready never reaches the browser clear", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = async (file, args) => {
      calls.push([file, ...args]);
      if (args.includes("devices")) return { code: 0, stdout: "List of devices attached\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };

    const result = await prepareDevice(DEVICE, APP, runner, "app-and-browser");

    expect(result.ready).toBe(false);
    expect(joined(calls).some((c) => c.includes("resolve-activity"))).toBe(false);
  });
});
