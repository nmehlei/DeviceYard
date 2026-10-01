import path from "path";
import { spawn } from "node:child_process";
import { defaultRunner, type CommandRunner } from "../maestro";
import { log } from "../telemetry/log";

export type ProcessSpawner = (file: string, args: string[]) => void;

export const defaultSpawner: ProcessSpawner = (file, args) => {
  const child = spawn(file, args, { stdio: "ignore" });
  // A ChildProcess is an EventEmitter - an 'error' event with no listener
  // (e.g. ENOENT when `adb` isn't on PATH, true for any CI agent without the
  // Android SDK installed) throws as an uncaught exception and crashes the
  // whole process. Best-effort like every other recording failure here: log
  // and move on, never bring anything down over a missing/unspawnable binary.
  child.on("error", (err) => {
    log.error("failed to spawn recording process", { file, err: String(err) });
  });
  child.unref();
};

export const RECORDING_TIME_LIMIT_SECONDS = 180;

const FINALIZE_DELAY_MS = 500;

export interface RecordingHandle {
  stop(): Promise<{ warning?: string }>;
}

function devicePath(ordinal: number): string {
  return `/sdcard/mdf-recording-${ordinal}.mp4`;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function startRecording(opts: {
  deviceId: string;
  debugDir: string;
  ordinal: number;
  runner?: CommandRunner;
  spawner?: ProcessSpawner;
  sleep?: (ms: number) => Promise<void>;
}): RecordingHandle {
  const runner = opts.runner ?? defaultRunner;
  const spawner = opts.spawner ?? defaultSpawner;
  const sleep = opts.sleep ?? defaultSleep;
  const remotePath = devicePath(opts.ordinal);

  spawner("adb", [
    "-s",
    opts.deviceId,
    "shell",
    "screenrecord",
    "--time-limit",
    String(RECORDING_TIME_LIMIT_SECONDS),
    remotePath,
  ]);

  return {
    async stop(): Promise<{ warning?: string }> {
      // `pkill` failing here is expected, not exceptional: a flow that runs
      // past the --time-limit cap (see RECORDING_TIME_LIMIT_SECONDS) makes
      // screenrecord exit on its own before this runs, so pkill matches no
      // process and returns non-zero even though a finalized recording is
      // sitting on the device waiting to be pulled. Never early-return on
      // this - the pull below is what actually determines whether a
      // recording was salvaged, so always attempt it regardless.
      const stopResult = await runner("adb", ["-s", opts.deviceId, "shell", "pkill", "-INT", "screenrecord"]);

      await sleep(FINALIZE_DELAY_MS);

      const localPath = path.join(opts.debugDir, "recording.mp4");
      const pullResult = await runner("adb", ["-s", opts.deviceId, "pull", remotePath, localPath]);
      if (pullResult.code !== 0) {
        const pullError = pullResult.stderr || pullResult.stdout || "unknown error";
        const stopContext =
          stopResult.code !== 0
            ? ` (stop signal also failed: ${stopResult.stderr || stopResult.stdout || "unknown error"})`
            : "";
        return {
          warning: `could not pull screen recording: ${pullError}${stopContext}`,
        };
      }

      await runner("adb", ["-s", opts.deviceId, "shell", "rm", remotePath]);

      return {};
    },
  };
}
