import { parseApk, UnsupportedFileError, ParseError } from "app-binary-info";

/** What resolveAppIdFromApk (and any override of it) resolves to: the
 * Android package name and, when present in the manifest, a human-readable
 * version string. appVersion is purely informational - unlike appId it
 * never reaches a shell command, so it needs no validation beyond existing
 * and being a string. */
export interface AppInfo {
  appId: string;
  appVersion: string | null;
}

export type AppIdResolver = (apkPath: string) => Promise<AppInfo>;

/** Thrown when the app id can't be read from an uploaded APK - either it
 * isn't a recognizable APK at all, or its manifest doesn't parse. Wraps
 * app-binary-info's own error types under this project's own error
 * vocabulary, the same way env.ts has its own EnvValidationError rather
 * than callers needing to know about a third-party library's exceptions. */
export class AppIdResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppIdResolutionError";
  }
}

/** A valid Android package name: one-or-more dot-separated segments, each
 * starting with a letter and containing only letters/digits/underscore,
 * with at least two segments. This is the trust boundary between the
 * untrusted uploaded file and the rest of the system - the resolved value
 * later reaches `adb shell am force-stop <appId>` and `adb shell pm clear
 * <appId>` in device.ts, where adb concatenates its arguments and runs them
 * through the device's shell. An uploaded APK with a crafted manifest
 * package name (e.g. containing `;` or spaces) must never reach that call
 * unvalidated - reject it here, before it becomes an app id at all. */
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** How long a single app-id resolution is allowed to take. app-binary-info
 * buffers the full decompressed manifest entry into memory with no cap or
 * timeout of its own, so a pathological archive could otherwise hold the
 * request (and its uploaded files) open indefinitely. This is an additional
 * guard alongside the multer upload-size cap, not a replacement for it - a
 * small archive can still decompress to something slow to parse. */
const RESOLUTION_TIMEOUT_MS = 10_000;

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AppIdResolutionError(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Combines versionName/versionCode into one display string. Both present ->
 * "name (code)"; only versionName -> just the name; neither -> null. Never
 * throws - a manifest with no version info at all is valid, just
 * uninformative. */
function formatAppVersion(versionName: string | undefined, versionCode: number | undefined): string | null {
  if (versionName && versionCode !== undefined) return `${versionName} (${versionCode})`;
  if (versionName) return versionName;
  return null;
}

/** Default resolver: reads the real package name and version straight out of
 * the uploaded APK's own manifest. There is nothing else to configure - the
 * values can never drift from what's actually about to be installed, since
 * they come from the exact file being installed. */
export const resolveAppIdFromApk: AppIdResolver = async (apkPath) => {
  try {
    const info = await withTimeout(
      parseApk(apkPath),
      RESOLUTION_TIMEOUT_MS,
      "timed out reading the app id from the uploaded apk"
    );
    if (!PACKAGE_NAME.test(info.packageName)) {
      throw new AppIdResolutionError(
        `the APK's manifest declares an implausible package name: ${JSON.stringify(info.packageName)}`
      );
    }
    return {
      appId: info.packageName,
      appVersion: formatAppVersion(info.versionName, info.versionCode),
    };
  } catch (err) {
    if (err instanceof AppIdResolutionError) {
      throw err;
    }
    if (err instanceof UnsupportedFileError || err instanceof ParseError) {
      throw new AppIdResolutionError(err.message);
    }
    throw err;
  }
};
