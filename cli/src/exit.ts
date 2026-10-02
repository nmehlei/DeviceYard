/** Matching dcd's codes exactly, so a pipeline that swaps `dcd cloud` for
 * `deviceyard cloud` keeps gating on the same numbers.
 * See https://docs.devicecloud.dev/advanced/exit-codes */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_FLOW_FAILED = 2;

/** Anything the user can fix by changing arguments, credentials or the
 * environment. Always EXIT_ERROR - never EXIT_FLOW_FAILED, because a CI job
 * that cannot tell "your test failed" from "your token expired" will retry
 * the wrong one. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}
