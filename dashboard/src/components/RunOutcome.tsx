import type { JobListEntry } from "../lib/api";
import { listJobOutcome } from "../lib/listJobOutcome";

const labels = { passed: "Passed", failed: "Failed", running: "Running", queued: "Queued", unknown: "No result" };
const symbols = { passed: "✓", failed: "×", running: "◌", queued: "○", unknown: "—" };
export function RunOutcome({ job }: { job: JobListEntry }) {
  const outcome = listJobOutcome(job);
  return <span className="run-outcome" data-outcome={outcome}><span aria-hidden="true">{symbols[outcome]}</span> {labels[outcome]}</span>;
}
