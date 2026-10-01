import {
  METRIC_NAMES,
  recordJobSubmitted,
  recordJobCompleted,
  recordFlowRun,
  recordRetentionEvicted,
} from "../../src/telemetry/metrics";

test("every instrument name is namespaced under farm.", () => {
  for (const name of Object.values(METRIC_NAMES)) {
    expect(name).toMatch(/^farm\./);
  }
});

test("no instrument name mentions a job id", () => {
  // A per-job label creates a new time series on every run, for ever.
  for (const name of Object.values(METRIC_NAMES)) {
    expect(name).not.toMatch(/job\.id|jobid/i);
  }
});

test("recording helpers do not throw with the no-op provider telemetry-off gives", () => {
  expect(() => {
    recordJobSubmitted("donable");
    recordJobCompleted("donable", "passed", 12.5, 1.25);
    recordFlowRun("failed");
    recordRetentionEvicted(3);
  }).not.toThrow();
});

test("no recording helper accepts a job id", () => {
  // The signatures are the enforcement, not a comment: none of them takes one.
  expect(recordJobSubmitted).toHaveLength(1); // org
  expect(recordJobCompleted).toHaveLength(4); // org, outcome, duration, queueWait
  expect(recordFlowRun).toHaveLength(1); // outcome
});

test("an empty retention sweep records nothing rather than a zero", () => {
  expect(() => recordRetentionEvicted(0)).not.toThrow();
});
