import type { JobStatus, StepStatus } from "../lib/api";

const LABELS: Record<JobStatus | StepStatus, string> = {
  queued: "Queued",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  skipped: "Skipped",
  done: "Done",
};

const COLORS: Record<JobStatus | StepStatus, string> = {
  queued: "var(--status-queued)",
  running: "var(--status-running)",
  passed: "var(--status-passed)",
  failed: "var(--status-failed)",
  skipped: "var(--status-skipped)",
  done: "var(--status-passed)",
};

export function StatusBadge({ status }: { status: JobStatus | StepStatus }) {
  return (
    <span
      className="mono inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium"
      style={{ backgroundColor: `color-mix(in srgb, ${COLORS[status]} 18%, transparent)`, color: COLORS[status] }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: COLORS[status] }} />
      {LABELS[status]}
    </span>
  );
}
