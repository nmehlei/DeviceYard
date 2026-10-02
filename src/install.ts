import type { CommandRunner } from "./maestro";
import { defaultRunner } from "./maestro";

export interface InstallResult {
  passed: boolean;
  stdout: string;
  stderr: string;
}

export async function installApk(
  deviceId: string,
  apkPath: string,
  appId: string,
  runner: CommandRunner = defaultRunner
): Promise<InstallResult> {
  // -d allows a LOWER versionCode to replace what is installed. The farm is a
  // test device, so the APK the caller just uploaded is by definition the one
  // they want on it - a version comparison against whatever ran last is not a
  // question worth asking here. Without this, a locally-built APK can never
  // replace a CI-built one: DonableApp derives versionCode from the pipeline's
  // Build.BuildId, so any CI build outranks every local build forever, and
  // adb refuses with INSTALL_FAILED_VERSION_DOWNGRADE.
  const adbInstall = () => runner("adb", ["-s", deviceId, "install", "-r", "-d", apkPath]);

  let { code, stdout, stderr } = await adbInstall();

  // Two failures share one recovery: uninstall, then install fresh.
  //
  // INSTALL_FAILED_UPDATE_INCOMPATIBLE - a leftover install signed with a
  // different key than the current build refuses `-r` outright, and adb has no
  // "replace regardless of signature" flag.
  //
  // INSTALL_FAILED_VERSION_DOWNGRADE - `-d` above covers most downgrades, but
  // it is refused for a non-debuggable (release-signed) APK on a `user` build,
  // which is exactly what a CI-produced release APK is. The flag is the cheap
  // path; this is the one that always works.
  //
  // Uninstalling costs nothing that is not already being lost: prepareDevice
  // runs `pm clear <appId>` before every job (src/device.ts), so app data does
  // not survive a run either way.
  const needsReinstall =
    stderr.includes("INSTALL_FAILED_UPDATE_INCOMPATIBLE") ||
    stderr.includes("INSTALL_FAILED_VERSION_DOWNGRADE");

  if (code !== 0 && needsReinstall) {
    await runner("adb", ["-s", deviceId, "uninstall", appId]);
    ({ code, stdout, stderr } = await adbInstall());
  }

  return { passed: code === 0, stdout, stderr };
}
