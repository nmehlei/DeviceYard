import { metrics } from "@opentelemetry/api";

/**
 * Cardinality rule, enforced by these signatures rather than by comment:
 * job.id is NEVER a metric attribute. Org and device are bounded sets. A
 * per-job label would create a new time series on every run, for ever, and
 * eventually cost real money on any backend. Per-job detail belongs on spans,
 * which is what they are for.
 *
 * With telemetry disabled the global meter provider is the no-op one, so each
 * of these is a couple of function calls and nothing else.
 */
export const METRIC_NAMES = {
  jobsSubmitted: "farm.jobs.submitted",
  jobsCompleted: "farm.jobs.completed",
  jobDuration: "farm.job.duration",
  jobQueueWait: "farm.job.queue_wait",
  flowsRun: "farm.flows.run",
  retentionEvicted: "farm.retention.evicted",
  queueDepth: "farm.queue.depth",
  artifactsBytes: "farm.artifacts.bytes",
} as const;

export type JobOutcome = "passed" | "failed" | "error";

function meter() {
  return metrics.getMeter("mobile-device-farm");
}

export function recordJobSubmitted(org: string): void {
  meter().createCounter(METRIC_NAMES.jobsSubmitted).add(1, { org });
}

export function recordJobCompleted(
  org: string,
  outcome: JobOutcome,
  durationSeconds: number,
  queueWaitSeconds: number
): void {
  meter().createCounter(METRIC_NAMES.jobsCompleted).add(1, { org, outcome });
  meter()
    .createHistogram(METRIC_NAMES.jobDuration, { unit: "s" })
    .record(durationSeconds, { outcome });
  meter().createHistogram(METRIC_NAMES.jobQueueWait, { unit: "s" }).record(queueWaitSeconds);
}

export function recordFlowRun(outcome: "passed" | "failed"): void {
  meter().createCounter(METRIC_NAMES.flowsRun).add(1, { outcome });
}

export function recordRetentionEvicted(count: number): void {
  if (count <= 0) return;
  meter().createCounter(METRIC_NAMES.retentionEvicted).add(count);
}

export function observeQueueDepth(fn: () => number): void {
  meter()
    .createObservableGauge(METRIC_NAMES.queueDepth, { unit: "{jobs}" })
    .addCallback((result) => result.observe(fn()));
}

export function observeArtifactBytes(fn: () => number): void {
  meter()
    .createObservableGauge(METRIC_NAMES.artifactsBytes, { unit: "By" })
    .addCallback((result) => result.observe(fn()));
}
