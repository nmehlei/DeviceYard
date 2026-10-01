/**
 * Fails a test when the HOST ran out of a resource underneath it.
 *
 * Why this exists: `src/server.ts` catches a job-start failure, logs it, and
 * marks the job "failed" rather than letting it hang - correct behaviour,
 * because CI polls GET /run/:id and a stuck job costs a fallback to a paid
 * device cloud. But nothing asserted the ABSENCE of such failures, so when the
 * machine actually ran out of disk the job died, the suite reported green, and
 * the run meant nothing. That was observed for real: three consecutive full
 * runs logged `ENOSPC: no space left on device, mkdtemp` from src/server.ts
 * while jest printed a pass.
 *
 * A suite that stays green while the system underneath it is broken is worse
 * than one that fails, because it hides the next real regression.
 *
 * Installed for every suite via `setupFilesAfterEnv` in jest.config.js.
 */

/**
 * Whole-word codes only, so `ENOSPCX` is not a match.
 *
 * EACCES is deliberately absent. Two suites induce it on purpose with chmod
 * (tests/artifacts/collector.test.ts, tests/index.test.ts) because a
 * permission failure is a plausible thing to simulate; running out of disk,
 * file handles or memory is not - that is always the machine, never the
 * scenario.
 */
const HOST_EXHAUSTION = /\b(?:ENOSPC|EMFILE|ENFILE|ENOMEM)\b/;

let observed: string[] = [];
let simulated = false;
let previousConsoleError: typeof console.error | undefined;

export function isHostExhaustion(message: string): boolean {
  return HOST_EXHAUSTION.test(message);
}

/** What the guard has collected during the current test. Exported so its own
 * test can prove the interception is real rather than only exercising the
 * matcher. */
export function observedHostErrors(): string[] {
  return [...observed];
}

/**
 * Declares that this test induces a host-exhaustion error on purpose, so the
 * guard stays quiet for it.
 *
 * Used by the regression test in tests/server.test.ts that mocks
 * `fs.mkdtempSync` to throw ENOSPC and asserts the job still reaches a
 * terminal status. An automatic "was this thrown by a fake?" heuristic would
 * be guesswork; an explicit opt-out is one line and cannot be wrong by
 * accident.
 */
export function expectSimulatedHostError(): void {
  simulated = true;
}

/** Pure decision function, separated from the hooks so it is directly
 * testable: the hook below is only plumbing. */
export function hostFailureReport(observedLines: string[], wasSimulated: boolean): string | undefined {
  if (wasSimulated || observedLines.length === 0) return undefined;
  const quoted = observedLines.slice(0, 3).map((line) => `    ${line}`).join("\n");
  return [
    "The host ran out of a resource while this test ran, so this run is not a real result.",
    "This is an environment failure, not a defect in the code under test - do not go looking",
    "for a bug until the machine is healthy. Check free disk space and open file handles.",
    "",
    "  Observed:",
    quoted,
    "",
    "  If this test induces the failure deliberately, call expectSimulatedHostError()",
    "  from tests/helpers/hostHealth.ts at the top of it.",
  ].join("\n");
}

beforeEach(() => {
  observed = [];
  simulated = false;
  // Capture whatever is installed right now rather than a module-load-time
  // reference: a suite may have its own console.error spy in place, and
  // restoring past it would strand that spy.
  previousConsoleError = console.error;
  const passthrough = previousConsoleError;
  console.error = (...args: unknown[]): void => {
    const line = args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" ");
    if (isHostExhaustion(line)) observed.push(line);
    passthrough(...args);
  };
});

afterEach(() => {
  if (previousConsoleError) console.error = previousConsoleError;
  const report = hostFailureReport(observed, simulated);
  observed = [];
  simulated = false;
  if (report) throw new Error(report);
});
