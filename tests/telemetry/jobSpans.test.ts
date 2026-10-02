import type { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { startTestTracing } from "../helpers/otelTestProvider";
import { makeJobHarness, type JobHarness } from "../helpers/jobRunnerHarness";
import { runJob } from "../../src/jobRunner";

let exporter: InMemorySpanExporter;
let stopTracing: () => void;
let harness: JobHarness | undefined;

beforeEach(() => {
  ({ exporter, stop: stopTracing } = startTestTracing());
});

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
  stopTracing();
});

function names(): string[] {
  return exporter.getFinishedSpans().map((s) => s.name);
}

test("a job produces the documented span tree", async () => {
  harness = makeJobHarness({ flows: ["login/signin"] });
  await runJob(harness.options);

  expect(names()).toEqual(
    expect.arrayContaining([
      "job",
      "device.prepare",
      "apk.install",
      "archive.extract",
      "flow.run",
      "maestro.exec",
    ])
  );
});

/** cleanup() runs twice on the abort path, and wrapping it in a span delayed
 * its trailing ENOENT log past test teardown. See the comment on cleanup in
 * src/jobRunner.ts. */
test("cleanup is deliberately not traced", async () => {
  harness = makeJobHarness({ flows: ["login/signin"] });
  await runJob(harness.options);

  expect(names()).not.toContain("job.cleanup");
});

test("the job span carries its identifying attributes", async () => {
  harness = makeJobHarness({ flows: ["login/signin"] });
  await runJob(harness.options);

  const job = exporter.getFinishedSpans().find((s) => s.name === "job")!;
  expect(job.attributes["job.id"]).toBeDefined();
  expect(job.attributes["device.id"]).toBe("emulator-5554");
  expect(job.attributes["app.id"]).toBe("net.donable.app.testing");
  expect(job.attributes["flow.count"]).toBe(1);
});

test("one flow.run span per flow, carrying its index", async () => {
  harness = makeJobHarness({ flows: ["a", "b", "c"] });
  await runJob(harness.options);

  const flows = exporter.getFinishedSpans().filter((s) => s.name === "flow.run");
  expect(flows).toHaveLength(3);
  expect(flows.map((s) => s.attributes["flow.index"]).sort()).toEqual([0, 1, 2]);
});

test("maestro.exec records the exit code but never the command line", async () => {
  harness = makeJobHarness({ flows: ["login/signin"] });
  await runJob(harness.options);

  const exec = exporter.getFinishedSpans().find((s) => s.name === "maestro.exec")!;
  expect(exec.attributes["process.exit_code"]).toBeDefined();
  for (const key of Object.keys(exec.attributes)) {
    expect(key).not.toMatch(/argv|command_line|command_args/);
  }
});

test("a secret passed through env never appears on any span", async () => {
  harness = makeJobHarness({
    flows: ["login/signin"],
    env: { E2E_PASSWORD: "hunter2" },
  });
  await runJob(harness.options);

  const dump = JSON.stringify(exporter.getFinishedSpans().map((s) => s.attributes));
  expect(dump).not.toContain("hunter2");
});

test("the job span records a passing outcome", async () => {
  harness = makeJobHarness({ flows: ["login/signin"] });
  await runJob(harness.options);

  const job = exporter.getFinishedSpans().find((s) => s.name === "job")!;
  expect(job.attributes["job.outcome"]).toBe("passed");
});

test("a failing flow still ends the job span, marked failed", async () => {
  harness = makeJobHarness({ flows: ["login/signin"], failFlow: true });
  await runJob(harness.options);

  const job = exporter.getFinishedSpans().find((s) => s.name === "job")!;
  expect(job.ended).toBe(true);
  expect(job.attributes["job.outcome"]).toBe("failed");
});

test("the pipeline spans are children of the job span", async () => {
  harness = makeJobHarness({ flows: ["login/signin"] });
  await runJob(harness.options);

  const spans = exporter.getFinishedSpans();
  const job = spans.find((s) => s.name === "job")!;
  const install = spans.find((s) => s.name === "apk.install")!;
  expect(install.parentSpanContext?.spanId).toBe(job.spanContext().spanId);
});
