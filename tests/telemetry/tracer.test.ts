import type { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { startTestTracing } from "../helpers/otelTestProvider";
import { withSpan, currentTraceIds } from "../../src/telemetry/tracer";

let exporter: InMemorySpanExporter;
let stop: () => void;

beforeEach(() => {
  ({ exporter, stop } = startTestTracing());
});

afterEach(() => {
  stop();
});

test("the span records the name and its attributes", async () => {
  await withSpan("job", { "job.id": "j-1" }, async () => "ok");
  const [span] = exporter.getFinishedSpans();
  expect(span.name).toBe("job");
  expect(span.attributes["job.id"]).toBe("j-1");
});

test("the callback's return value is passed through", async () => {
  await expect(withSpan("job", {}, async () => 42)).resolves.toBe(42);
});

test("secret-named attributes never reach the span", async () => {
  await withSpan("job", { "env.API_TOKEN": "s3cr3t" }, async () => "ok");
  const [span] = exporter.getFinishedSpans();
  expect(span.attributes["env.API_TOKEN"]).not.toBe("s3cr3t");
});

test("a throwing callback rethrows unchanged and the span ends with an error", async () => {
  const boom = new Error("boom");
  await expect(
    withSpan("job", {}, async () => {
      throw boom;
    })
  ).rejects.toBe(boom);
  const [span] = exporter.getFinishedSpans();
  expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
});

test("the span is ended even when the callback throws", async () => {
  await expect(
    withSpan("job", {}, async () => {
      throw new Error("boom");
    })
  ).rejects.toThrow();
  expect(exporter.getFinishedSpans()).toHaveLength(1);
});

test("nested calls produce a parent-child relationship", async () => {
  await withSpan("job", {}, async () => {
    await withSpan("apk.install", {}, async () => "ok");
  });
  const spans = exporter.getFinishedSpans();
  const child = spans.find((s) => s.name === "apk.install")!;
  const parent = spans.find((s) => s.name === "job")!;
  expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
});

test("currentTraceIds is empty outside any span", () => {
  expect(currentTraceIds()).toEqual({});
});

test("currentTraceIds reports the active span's ids", async () => {
  await withSpan("job", {}, async () => {
    const ids = currentTraceIds();
    expect(ids.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(ids.span_id).toMatch(/^[0-9a-f]{16}$/);
  });
});
