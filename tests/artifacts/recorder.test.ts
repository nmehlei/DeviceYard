import fs from "fs";
import os from "os";
import path from "path";
import { startRecording, defaultSpawner, RECORDING_TIME_LIMIT_SECONDS, type ProcessSpawner } from "../../src/artifacts/recorder";
import type { CommandRunner } from "../../src/maestro";

let debugDir: string;

beforeEach(() => {
  debugDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-recorder-"));
});

afterEach(() => {
  fs.rmSync(debugDir, { recursive: true, force: true });
});

function instantSleep(): Promise<void> {
  return Promise.resolve();
}

function describeCall(call: { args: string[] }): string {
  if (call.args.includes("pull")) return "pull";
  if (call.args.includes("rm")) return "rm";
  if (call.args.includes("pkill")) return "pkill";
  return "unknown";
}

test("start spawns adb shell screenrecord with the device path and time limit", () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const spawner: ProcessSpawner = (file, args) => calls.push({ file, args });

  startRecording({ deviceId: "emulator-5554", debugDir, ordinal: 3, spawner, sleep: instantSleep });

  expect(calls).toEqual([
    {
      file: "adb",
      args: [
        "-s",
        "emulator-5554",
        "shell",
        "screenrecord",
        "--time-limit",
        String(RECORDING_TIME_LIMIT_SECONDS),
        "/sdcard/mdf-recording-3.mp4",
      ],
    },
  ]);
});

test("stop sends SIGINT, pulls the file into debugDir as recording.mp4, then removes it from the device", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const runner: CommandRunner = async (file, args) => {
    calls.push({ file, args });
    if (args.includes("pull")) {
      // The real adb binary writes bytes to the destination as a side
      // effect, not through stdout - simulate that here so the assertion
      // below can check the file actually landed where collectArtifacts
      // expects to find it.
      fs.writeFileSync(args[args.length - 1], "fake-mp4-bytes");
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  const handle = startRecording({
    deviceId: "emulator-5554",
    debugDir,
    ordinal: 0,
    runner,
    spawner: () => {},
    sleep: instantSleep,
  });
  const result = await handle.stop();

  expect(result.warning).toBeUndefined();
  expect(fs.readFileSync(path.join(debugDir, "recording.mp4"), "utf8")).toBe("fake-mp4-bytes");
  expect(calls.map(describeCall)).toEqual(["pkill", "pull", "rm"]);
});

test("stop resolves with a warning, never throws, when both the stop signal and the pull fail", async () => {
  // pkill failing alone is the expected >180s case (screenrecord already
  // exited on its own before pkill ran) and must not be treated as fatal -
  // see the next test. This test covers the genuinely unsalvageable case:
  // pkill fails AND the pull also fails, so there's really nothing to
  // recover.
  const runner: CommandRunner = async (_file, args) => {
    if (args.includes("pkill")) return { code: 1, stdout: "", stderr: "no such process" };
    if (args.includes("pull")) return { code: 1, stdout: "", stderr: "remote object does not exist" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const handle = startRecording({
    deviceId: "emulator-5554",
    debugDir,
    ordinal: 0,
    runner,
    spawner: () => {},
    sleep: instantSleep,
  });

  const result = await handle.stop();

  expect(result.warning).toContain("could not pull screen recording");
  expect(result.warning).toContain("remote object does not exist");
  expect(fs.existsSync(path.join(debugDir, "recording.mp4"))).toBe(false);
});

test("stop still pulls and succeeds when pkill fails because screenrecord already exited on its own (the >180s case)", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const runner: CommandRunner = async (file, args) => {
    calls.push({ file, args });
    if (args.includes("pkill")) return { code: 1, stdout: "", stderr: "no such process" };
    if (args.includes("pull")) {
      fs.writeFileSync(args[args.length - 1], "fake-mp4-bytes");
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const handle = startRecording({
    deviceId: "emulator-5554",
    debugDir,
    ordinal: 0,
    runner,
    spawner: () => {},
    sleep: instantSleep,
  });

  const result = await handle.stop();

  expect(result.warning).toBeUndefined();
  expect(fs.readFileSync(path.join(debugDir, "recording.mp4"), "utf8")).toBe("fake-mp4-bytes");
  expect(calls.map(describeCall)).toEqual(["pkill", "pull", "rm"]);
});

test("stop resolves with a warning, never throws, when the pull fails", async () => {
  const runner: CommandRunner = async (_file, args) => {
    if (args.includes("pull")) return { code: 1, stdout: "", stderr: "remote object does not exist" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const handle = startRecording({
    deviceId: "emulator-5554",
    debugDir,
    ordinal: 0,
    runner,
    spawner: () => {},
    sleep: instantSleep,
  });

  const result = await handle.stop();

  expect(result.warning).toContain("could not pull screen recording");
});

// A bare `spawn` with no 'error' listener throws an uncaught exception on
// ENOENT and crashes the whole process - exactly what happens on a CI agent
// with no Android SDK/adb installed. This test's own success IS the
// regression check: without the fix, this whole file (and any test file
// running in the same worker) would crash rather than report a failure here.
test("defaultSpawner does not crash the process when the binary does not exist", (done) => {
  expect(() => defaultSpawner("definitely-not-a-real-binary-xyz", [])).not.toThrow();
  // Give the async 'error' event a tick to fire before the test completes.
  setTimeout(done, 50);
});
