import type { JobRow, JobStatus, StepRow } from "./rows";

/**
 * Rebuilds the exact response shapes DonableApp's pipeline consumes, from the
 * new row model. Kept in its own module so the frozen contract is reviewable
 * in one place rather than spread through route handlers.
 *
 * Setup steps are reported the way they always were - as pseudo-results named
 * <device>, <install> and <extract> - but only when they fail, which is the
 * only case the old code ever produced them for.
 */
export interface LegacyResult {
  flow: string;
  passed: boolean;
  stdout: string;
  stderr: string;
}

export interface LegacyJob {
  id: string;
  org: string;
  flows: string[];
  status: JobStatus;
  results: LegacyResult[];
  error?: string;
  createdAt: number;
}

export function toLegacyJob(
  job: JobRow,
  steps: StepRow[],
  readOutput: (step: StepRow) => { stdout: string; stderr: string }
): LegacyJob {
  const flows = steps.filter((s) => s.kind === "flow").map((s) => s.name);

  const failedSetup = steps.find((s) => s.kind === "setup" && s.status === "failed");
  const results: LegacyResult[] = failedSetup
    ? [{ flow: `<${failedSetup.name}>`, passed: false, ...readOutput(failedSetup) }]
    : steps
        .filter((s) => s.kind === "flow" && (s.status === "passed" || s.status === "failed"))
        .map((s) => ({
          flow: s.resolvedPath ?? s.name,
          passed: s.status === "passed",
          ...readOutput(s),
        }));

  const legacy: LegacyJob = {
    id: job.id,
    org: job.org,
    flows,
    status: job.status,
    results,
    createdAt: job.createdAt,
  };

  if (job.error) legacy.error = job.error;
  return legacy;
}
