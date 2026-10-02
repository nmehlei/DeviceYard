import type { JobDetail } from "./api";

export function jobOutcome({ job, steps }: JobDetail) {
  const flows = steps.filter((step) => step.kind === "flow");
  const counts = { passed: 0, failed: 0, running: 0, queued: 0, skipped: 0 };
  for (const flow of flows) counts[flow.status]++;
  if (job.status === "queued") return { title: "Queued", tone: "queued", symbol: "◷", counts };
  if (job.status === "running") return { title: "Running flows", tone: "running", symbol: "↻", counts };
  if (job.status === "failed" || steps.some((step) => step.status === "failed")) {
    return { title: "Job failed", tone: "failed", symbol: "×", counts };
  }
  if (flows.length > 0 && counts.passed === flows.length) {
    return { title: "All flows passed", tone: "passed", symbol: "✓", counts };
  }
  return { title: flows.length === 0 ? "Completed — no flows ran" : "Completed", tone: "queued", symbol: "—", counts };
}

export function durationLabel(start: number | null, end: number | null) {
  if (start === null || end === null) return "—";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
