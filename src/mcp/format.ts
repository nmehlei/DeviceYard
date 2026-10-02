// src/mcp/format.ts
import type { JobDetail, JobSummary, StepRow } from "./apiTypes";

export const TAIL_LINES = 100;
export const TAIL_CHARS = 8000;
/** Exported so a caller that truncated the file BEFORE this function ever
 * saw it (get_artifact fetching only a byte range) can still guarantee the
 * marker is present exactly once. */
export const TRUNCATION_MARKER = "[truncated - showing the tail; fetch the artifact for the full file]";

/** Keeps the END of a log, not the start: Maestro writes the failure last,
 * and an agent handed the first 100 lines of a passing preamble learns
 * nothing. The marker matters as much as the truncation - without it the
 * agent cannot tell a short log from a trimmed one, and will not know to
 * fetch the whole file. */
export function tail(text: string): string {
  const lines = text.split("\n");
  let truncated = false;
  let kept = lines;
  if (lines.length > TAIL_LINES) {
    kept = lines.slice(-TAIL_LINES);
    truncated = true;
  }
  let out = kept.join("\n");
  if (out.length > TAIL_CHARS) {
    out = out.slice(-TAIL_CHARS);
    truncated = true;
  }
  return truncated ? `${TRUNCATION_MARKER}\n${out}` : out;
}

/** Timestamps cross the wire as epoch milliseconds. An agent reasons about
 * an ISO string; it cannot do anything useful with 1756718400000. */
function when(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "unknown";
  return new Date(ms).toISOString();
}

function duration(step: StepRow): string {
  if (step.startedAt === null || step.finishedAt === null) return "";
  const ms = step.finishedAt - step.startedAt;
  if (!Number.isFinite(ms) || ms < 0) return "";
  return ` ${Math.round(ms / 1000)}s`;
}

function verdict(step: StepRow): string {
  if (step.status === "passed") return "PASS ";
  if (step.status === "failed") return "FAIL ";
  return step.status.toUpperCase().padEnd(5);
}

export function formatJobDetail(detail: JobDetail): string {
  const lines: string[] = [];
  lines.push(`job ${detail.job.id} - status ${detail.job.status} - created ${when(detail.job.createdAt)}`);

  // A runner error is not a test failure: one means the farm broke, the
  // other means the app did. Conflating them sends an agent to debug the
  // wrong system.
  if (detail.job.error) lines.push(`runner error: ${detail.job.error}`);

  if (detail.steps.length === 0) {
    lines.push("no steps recorded yet");
    return lines.join("\n");
  }

  for (const step of detail.steps) {
    // Setup steps (install the APK, unpack the flows) are marked, for the
    // same reason job.error is: a failed setup is the farm's problem, not
    // the app's, and an agent must not go debugging its own test for it.
    const label = step.kind === "setup" ? `[setup] ${step.name}` : step.name;
    lines.push(` ${verdict(step)} ${label}${duration(step)}`);
    if (step.status === "failed" && step.exitCode !== null) {
      lines.push(`        exit code ${step.exitCode}`);
    }
    for (const artifact of step.artifacts ?? []) {
      lines.push(`        ${artifact.kind} (id ${artifact.id}, ${artifact.bytes} bytes)`);
    }
  }

  // Counted over flow steps only, matching what GET /api/jobs' own
  // summarise() reports, so the two views never disagree.
  const flows = detail.steps.filter((s) => s.kind === "flow");
  const passed = flows.filter((s) => s.status === "passed").length;
  const failed = flows.filter((s) => s.status === "failed").length;
  lines.push(`${passed} passed, ${failed} failed, ${flows.length} flows`);
  return lines.join("\n");
}

export function formatJobList(jobs: JobSummary[]): string {
  if (jobs.length === 0) return "no jobs for this org yet";
  return jobs
    .map((j) => `${j.id}  ${j.status}  ${j.passed} passed, ${j.failed} failed of ${j.flowCount}  ${when(j.createdAt)}`)
    .join("\n");
}
