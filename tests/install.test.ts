import { INSTALL_TIMEOUT_MS, installApk } from "../src/install";
import { DEFAULT_TIMEOUT_MS, type CommandRunner } from "../src/maestro";

test("passed is true when the command exits 0", async () => {
  const fakeRunner: CommandRunner = async () => ({
    code: 0,
    stdout: "Success",
    stderr: "",
  });

  const result = await installApk("emulator-5554", "/tmp/app.apk", "app.momentum.testing", fakeRunner);

  expect(result).toEqual({
    passed: true,
    stdout: "Success",
    stderr: "",
  });
});

test("passed is false when the command exits non-zero, stderr preserved", async () => {
  const fakeRunner: CommandRunner = async () => ({
    code: 1,
    stdout: "",
    stderr: "INSTALL_FAILED_INSUFFICIENT_STORAGE",
  });

  const result = await installApk("emulator-5554", "/tmp/app.apk", "app.momentum.testing", fakeRunner);

  expect(result.passed).toBe(false);
  expect(result.stderr).toBe("INSTALL_FAILED_INSUFFICIENT_STORAGE");
});

test("invokes adb with -s, install, -r, -d, and the apk path", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const fakeRunner: CommandRunner = async (file, args) => {
    calls.push({ file, args });
    return { code: 0, stdout: "", stderr: "" };
  };

  await installApk("emulator-5554", "/tmp/app.apk", "app.momentum.testing", fakeRunner);

  expect(calls).toEqual([
    {
      file: "adb",
      args: ["-s", "emulator-5554", "install", "-r", "-d", "/tmp/app.apk"],
    },
  ]);
});

test("on signature mismatch, uninstalls the app and retries once", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  let installAttempt = 0;
  const fakeRunner: CommandRunner = async (file, args) => {
    calls.push({ file, args });
    if (args[2] === "install") {
      installAttempt += 1;
      if (installAttempt === 1) {
        return { code: 1, stdout: "", stderr: "INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match" };
      }
      return { code: 0, stdout: "Success", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  const result = await installApk("emulator-5554", "/tmp/app.apk", "app.momentum.testing", fakeRunner);

  expect(result).toEqual({ passed: true, stdout: "Success", stderr: "" });
  expect(calls).toEqual([
    { file: "adb", args: ["-s", "emulator-5554", "install", "-r", "-d", "/tmp/app.apk"] },
    { file: "adb", args: ["-s", "emulator-5554", "uninstall", "app.momentum.testing"] },
    { file: "adb", args: ["-s", "emulator-5554", "install", "-r", "-d", "/tmp/app.apk"] },
  ]);
});

test("if signature mismatch persists after uninstall+retry, the retry's failure is returned", async () => {
  const fakeRunner: CommandRunner = async (file, args) => {
    if (args[2] === "install") {
      return { code: 1, stdout: "", stderr: "INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  const result = await installApk("emulator-5554", "/tmp/app.apk", "app.momentum.testing", fakeRunner);

  expect(result.passed).toBe(false);
  expect(result.stderr).toBe("INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match");
});

// The blocker this flag pair exists for: DonableApp derives versionCode from
// the pipeline's Build.BuildId, so a CI build always outranks a local one and a
// developer can never install a locally-built APK over it. `-d` is the cheap
// path; the uninstall+retry below is what survives a release-signed APK on a
// `user` build, where `-d` is refused.
test("on version downgrade, uninstalls the app and retries once", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  let installAttempt = 0;
  const fakeRunner: CommandRunner = async (file, args) => {
    calls.push({ file, args });
    if (args[2] === "install") {
      installAttempt += 1;
      if (installAttempt === 1) {
        return {
          code: 1,
          stdout: "",
          stderr: "adb: failed to install /tmp/app.apk: Failure [INSTALL_FAILED_VERSION_DOWNGRADE]",
        };
      }
      return { code: 0, stdout: "Success", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  const result = await installApk("emulator-5554", "/tmp/app.apk", "app.momentum.testing", fakeRunner);

  expect(result).toEqual({ passed: true, stdout: "Success", stderr: "" });
  expect(calls).toEqual([
    { file: "adb", args: ["-s", "emulator-5554", "install", "-r", "-d", "/tmp/app.apk"] },
    { file: "adb", args: ["-s", "emulator-5554", "uninstall", "app.momentum.testing"] },
    { file: "adb", args: ["-s", "emulator-5554", "install", "-r", "-d", "/tmp/app.apk"] },
  ]);
});

test("a downgrade that persists after uninstall+retry returns the retry's failure", async () => {
  const fakeRunner: CommandRunner = async (file, args) => {
    if (args[2] === "install") {
      return { code: 1, stdout: "", stderr: "Failure [INSTALL_FAILED_VERSION_DOWNGRADE]" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  const result = await installApk("emulator-5554", "/tmp/app.apk", "app.momentum.testing", fakeRunner);

  expect(result.passed).toBe(false);
  expect(result.stderr).toBe("Failure [INSTALL_FAILED_VERSION_DOWNGRADE]");
});

test("an unrelated failure is not retried", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const fakeRunner: CommandRunner = async (file, args) => {
    calls.push({ file, args });
    return { code: 1, stdout: "", stderr: "INSTALL_FAILED_INSUFFICIENT_STORAGE" };
  };

  const result = await installApk("emulator-5554", "/tmp/app.apk", "app.momentum.testing", fakeRunner);

  expect(result.passed).toBe(false);
  // One attempt only - no uninstall, no retry.
  expect(calls).toHaveLength(1);
});

test("an install gives up well before the job's own timeout, so a hung install fails the job with its own error", () => {
  expect(INSTALL_TIMEOUT_MS).toBe(5 * 60 * 1000);
  expect(INSTALL_TIMEOUT_MS).toBeLessThan(DEFAULT_TIMEOUT_MS);
});
