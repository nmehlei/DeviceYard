import { execFile } from "node:child_process";

export type CommandRunner = (
  file: string,
  args: string[]
) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * Default timeout for a single Maestro invocation. Without this, a hung
 * flow (device wedged, app frozen) blocks the single-device queue forever.
 */
export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export const defaultRunner: CommandRunner = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: DEFAULT_TIMEOUT_MS, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        // A non-numeric error.code (e.g. the string "ENOENT") means execFile
        // could not even launch the binary (bad PATH, missing binary) - this
        // is distinct from the process running and exiting non-zero because
        // a flow failed. Report `passed: false` the same way (code: 1) so
        // existing pass/fail behavior is unchanged, but surface the spawn
        // error's message in stderr so operators can tell "maestro ran and
        // the test failed" apart from "maestro could not be launched at all".
        if (error && typeof error.code !== "number") {
          const spawnNote = `[runner] failed to launch "${file}": ${error.message}`;
          const combinedStderr = stderr ? `${spawnNote}\n${stderr}` : spawnNote;
          resolve({ code: 1, stdout, stderr: combinedStderr });
          return;
        }

        const code = error ? (error.code as number) : 0;
        resolve({ code, stdout, stderr });
      }
    );
  });

export interface FlowResult {
  flow: string;
  passed: boolean;
  stdout: string;
  stderr: string;
}

// `maestro --version` has a real JVM cold-start cost - measured ~4.5s on a
// dev machine, so it's routinely right at or past a timeout sized for
// near-instant adb status checks (api/devices.ts's DEVICE_STATUS_TIMEOUT_MS,
// 5s). Using that shorter timeout here made the About page report "unknown"
// far more often than not. Generous but still bounded: a genuinely wedged
// or missing binary shouldn't hang the About page for long, but real JVM
// startup variance (a slower host, a cold filesystem cache) needs headroom
// well past 5s.
const VERSION_CHECK_TIMEOUT_MS = 20_000;

export const versionCheckRunner: CommandRunner = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: VERSION_CHECK_TIMEOUT_MS, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") {
        resolve({ code: 1, stdout, stderr });
        return;
      }
      resolve({ code: error ? (error.code as number) : 0, stdout, stderr });
    });
  });

/** Best-effort, like every other status read in this codebase: a failed or
 * unparseable version check must never be fatal, just report "unknown".
 * Returns whatever `maestro --version` prints, trimmed - Maestro's own
 * output isn't a bare semver (it's a banner line containing one), and
 * re-parsing it here would be one more thing to keep in sync with a CLI
 * this repo doesn't control. Defaults to versionCheckRunner, not
 * defaultRunner (this repo's own 15-minute flow-execution timeout) or a
 * device-status-scale timeout (too short, see above) - callers that need to
 * inject a fake for tests still can via the runner param. */
export async function getMaestroVersion(runner: CommandRunner = versionCheckRunner): Promise<string> {
  const { code, stdout } = await runner("maestro", ["--version"]);
  if (code !== 0) return "unknown";
  return stdout.trim() || "unknown";
}

export async function runMaestroFlow(
  deviceId: string,
  flowPath: string,
  runner: CommandRunner = defaultRunner,
  debugDir?: string,
  env?: Record<string, string>
): Promise<FlowResult> {
  // Maestro 2.6.1: --debug-output writes screenshots/hierarchy/maestro.log
  // for the run into the given directory; --flatten-debug-output keeps them
  // directly in it instead of nested under a generated flow-name subfolder,
  // which is what collectArtifacts expects to walk. Omitting debugDir keeps
  // the argument list identical to before this option existed - tests in
  // tests/maestro.test.ts assert on that exact list.

  // Sorted so argv is deterministic: without this the exact-match assertions
  // in tests/maestro.test.ts become order-dependent and flaky. Order carries
  // no meaning for -e, so nothing is lost by fixing it.
  const envArgs = env
    ? Object.keys(env).sort().flatMap((key) => ["-e", `${key}=${env[key]}`])
    : [];

  const args = debugDir
    ? ["--device", deviceId, "test", "--debug-output", debugDir, "--flatten-debug-output", ...envArgs, flowPath]
    : ["--device", deviceId, "test", ...envArgs, flowPath];
  const { code, stdout, stderr } = await runner("maestro", args);
  return { flow: flowPath, passed: code === 0, stdout, stderr };
}
