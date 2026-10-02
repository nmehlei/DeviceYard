import type { JobListEntry } from "./api";

export function listJobOutcome(job: JobListEntry): "passed" | "failed" | "running" | "queued" | "unknown" {
  if (job.status === "running" || job.status === "queued") return job.status;
  if (job.status === "failed" || job.failed > 0) return "failed";
  return job.flowCount > 0 && job.passed === job.flowCount ? "passed" : "unknown";
}
