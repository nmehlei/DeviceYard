import type { JobListEntry } from "./api";

export function completedDuration(job: JobListEntry): number | null {
  return (job.status === "done" || job.status === "failed") && job.startedAt != null && job.finishedAt != null
    ? Math.max(0, job.finishedAt - job.startedAt) : null;
}
export function formatRunDuration(milliseconds: number | null): string {
  if (milliseconds === null) return "—";
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
}
