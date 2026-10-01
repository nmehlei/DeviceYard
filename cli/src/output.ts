import type { Io } from "./main";

export interface Progress {
  step(name: string, status: string): void;
  /** Announces the JOB's own status, separately from its steps - there are no
   * steps to print yet while a job sits queued behind someone else's on the
   * farm's single device. Build 2395: a job queued 2h41m behind a 31-flow run
   * produced the exact same silence as a genuine CLI hang, and was mistaken
   * for one. Prints once per status, and again periodically while queued, so
   * a long wait looks different from a stall in the log. */
  status(status: string): void;
}

/** How often to repeat the "still queued" line. Short enough that a human
 * watching a live pipeline log sees it well within a minute; long enough
 * that it never competes with step output for attention. */
const QUEUE_HEARTBEAT_MS = 60_000;

/** --quiet suppresses per-step lines only. The run summary always prints: a
 * pipeline that asked for less noise still needs to be told what happened. */
export function createProgress(io: Io, quiet: boolean, now: () => number = Date.now): Progress {
  const seen = new Set<string>();
  let lastStatus: string | undefined;
  let lastAnnouncedAt = 0;
  return {
    step(name, status) {
      if (quiet) return;
      // The SSE stream re-sends the FULL job payload on every step landing,
      // so without this every step would reprint on every frame.
      const key = `${name}:${status}`;
      if (seen.has(key)) return;
      seen.add(key);
      const mark = status === "passed" ? "PASS" : status === "failed" ? "FAIL" : "....";
      io.out(`${mark}  ${name}`);
    },
    status(status) {
      if (quiet) return;
      // "done"/"failed" say nothing here - summarise() already reports the
      // verdict, with the actual flow results, once the job is terminal.
      if (status === "done" || status === "failed") return;
      const changed = status !== lastStatus;
      const heartbeatDue = status === "queued" && now() - lastAnnouncedAt >= QUEUE_HEARTBEAT_MS;
      if (!changed && !heartbeatDue) return;
      lastStatus = status;
      lastAnnouncedAt = now();
      io.out(status === "queued" ? "....  waiting for a device (job queued)" : "....  device acquired, job running");
    },
  };
}
