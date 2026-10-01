import { UnsupportedFileError, ParseError } from "app-binary-info";
import { resolveAppIdFromApk, AppIdResolutionError } from "../src/appId";

jest.mock("app-binary-info", () => {
  const actual = jest.requireActual("app-binary-info");
  return { ...actual, parseApk: jest.fn() };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseApk } = require("app-binary-info") as { parseApk: jest.Mock };

beforeEach(() => {
  parseApk.mockReset();
});

test("returns the package name from a successfully parsed APK", async () => {
  parseApk.mockResolvedValue({ platform: "android", packageName: "com.example.app", versionCode: 1, versionName: "1.0" });
  const info = await resolveAppIdFromApk("/tmp/app.apk");
  expect(info.appId).toBe("com.example.app");
  expect(parseApk).toHaveBeenCalledWith("/tmp/app.apk");
});

test("wraps UnsupportedFileError as AppIdResolutionError, preserving the message", async () => {
  parseApk.mockRejectedValue(new UnsupportedFileError("no AndroidManifest.xml entry found - not a recognizable APK"));
  await expect(resolveAppIdFromApk("/tmp/not-an-apk")).rejects.toThrow(AppIdResolutionError);
  await expect(resolveAppIdFromApk("/tmp/not-an-apk")).rejects.toThrow("no AndroidManifest.xml entry found - not a recognizable APK");
});

test("wraps ParseError as AppIdResolutionError, preserving the message", async () => {
  parseApk.mockRejectedValue(new ParseError("AndroidManifest.xml's <manifest> tag has no package attribute"));
  await expect(resolveAppIdFromApk("/tmp/corrupt.apk")).rejects.toThrow(AppIdResolutionError);
  await expect(resolveAppIdFromApk("/tmp/corrupt.apk")).rejects.toThrow("AndroidManifest.xml's <manifest> tag has no package attribute");
});

test("does not wrap an unrelated error - rethrows it as-is", async () => {
  const unrelated = new Error("disk full");
  parseApk.mockRejectedValue(unrelated);
  await expect(resolveAppIdFromApk("/tmp/app.apk")).rejects.toBe(unrelated);
});

test("rejects an implausible package name from the manifest instead of returning it", async () => {
  parseApk.mockResolvedValue({ platform: "android", packageName: "x; rm -rf /", versionCode: 1, versionName: "1.0" });
  await expect(resolveAppIdFromApk("/tmp/malicious.apk")).rejects.toThrow(AppIdResolutionError);
  await expect(resolveAppIdFromApk("/tmp/malicious.apk")).rejects.toThrow(/implausible package name/);
});

test("still resolves a normal package name successfully", async () => {
  parseApk.mockResolvedValue({ platform: "android", packageName: "com.example.app", versionCode: 1, versionName: "1.0" });
  const info = await resolveAppIdFromApk("/tmp/app.apk");
  expect(info.appId).toBe("com.example.app");
});

test("rejects with AppIdResolutionError if parseApk never resolves, instead of hanging the request", async () => {
  // Fake timers so the module's real 10s timeout can be driven forward
  // instantly - resolveAppIdFromApk has no parameter to inject a shorter
  // value, and the assertion only cares that it rejects within a bounded
  // time, not about the wall-clock duration.
  jest.useFakeTimers();
  try {
    parseApk.mockImplementation(() => new Promise(() => {}));
    const pending = resolveAppIdFromApk("/tmp/slow.apk");
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await jest.advanceTimersByTimeAsync(10_000);
    await assertion;
  } finally {
    jest.useRealTimers();
  }
});
