// src/mcp/tools/waitForJob.ts
import type { FarmClient } from "../client";
import { formatJobDetail } from "../format";
import { textResult, errorResult, type ToolResult } from "../result";
import { describeFarmError } from "./reads";
import type { JobDetail } from "../apiTypes";

export const DEFAULT_WAIT_SECONDS = 600;
export const MAX_WAIT_SECONDS = 1800;

export function clampWaitSeconds(value: number | undefined): number {
  const n = Number(value ?? DEFAULT_WAIT_SECONDS);
  if (!Number.isFinite(n) || n === 0) return n === 0 ? 1 : DEFAULT_WAIT_SECONDS;
  return Math.max(1, Math.min(Math.floor(n), MAX_WAIT_SECONDS));
}

const TERMINAL = new Set(["done", "failed"]);

function isDetail(frame: unknown): frame is JobDetail {
  return typeof frame === "object" && frame !== null && "job" in frame;
}

export async function waitForJob(
  client: FarmClient,
  args: { jobId: string; timeoutSeconds?: number },
): Promise<ToolResult> {
  const budgetSeconds = clampWaitSeconds(args.timeoutSeconds);
  const eventsPath = `/api/jobs/${encodeURIComponent(args.jobId)}/events`;

  let latest: JobDetail | undefined;
  let polledAfterDrop = false;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, budgetSeconds * 1000);

  try {
    try {
      await client.openEvents(eventsPath, (frame) => {
        if (!isDetail(frame)) return;
        latest = frame;
        if (TERMINAL.has(frame.job.status)) controller.abort();
      }, controller.signal);
    } catch (err) {
      // A stream that fails outright is not fatal on its own: the poll
      // below is the authority. Only if that also fails do we report. This
      // is the ONE fallback poll - a result here (terminal or not) is final
      // and must not be followed by a second poll below.
      if (latest === undefined) {
        try {
          latest = await client.getJson<JobDetail>(`/api/jobs/${encodeURIComponent(args.jobId)}`);
          polledAfterDrop = true;
        } catch {
          return errorResult(describeFarmError(err));
        }
      }
    }

    if (latest && TERMINAL.has(latest.job.status)) {
      return textResult(formatJobDetail(latest));
    }

    if (timedOut) {
      // Deliberately NOT an error: a long run that has not finished is
      // information. Returning isError here would train an agent to treat a
      // healthy ten-minute job as a broken farm.
      if (latest === undefined) {
        // The stream produced nothing at all (no heartbeat, no frames) for
        // the whole budget - up to 30 minutes. Returning "no state" after
        // that when one GET would answer is the least useful thing this tool
        // could do; the contract is "the last known job state".
        try {
          latest = await client.getJson<JobDetail>(`/api/jobs/${encodeURIComponent(args.jobId)}`);
        } catch {
          // Still nothing to report - fall through to the message below
          // rather than turning a timeout into an error result.
        }
        // The budget elapsed on a silent stream, but the poll may show the
        // job actually finished. Reporting "still running" then would be a
        // lie the agent would act on.
        if (latest && TERMINAL.has(latest.job.status)) return textResult(formatJobDetail(latest));
      }
      const state = latest ? formatJobDetail(latest) : "no state received from the farm yet";
      return textResult(
        `job ${args.jobId} is still running after ${budgetSeconds}s (the wait budget, not a failure). ` +
        `Call wait_for_job again to keep waiting.\n\n${state}`,
      );
    }

    if (polledAfterDrop) {
      // Already spent this call's one fallback poll (inside the catch
      // above) and it came back non-terminal - report that, don't poll again.
      return textResult(
        `the event stream for job ${args.jobId} ended before the job reached a terminal status. ` +
        `Its current state is below; call wait_for_job again to resume watching.\n\n${formatJobDetail(latest!)}`,
      );
    }

    // The stream ended cleanly (no throw) without a terminal frame - a known
    // SSE gap (no heartbeat, no retry:). One poll settles it rather than
    // reporting a phantom failure.
    try {
      const polled = await client.getJson<JobDetail>(`/api/jobs/${encodeURIComponent(args.jobId)}`);
      if (TERMINAL.has(polled.job.status)) return textResult(formatJobDetail(polled));
      return textResult(
        `the event stream for job ${args.jobId} ended before the job reached a terminal status. ` +
        `Its current state is below; call wait_for_job again to resume watching.\n\n${formatJobDetail(polled)}`,
      );
    } catch (err) {
      return errorResult(describeFarmError(err));
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
