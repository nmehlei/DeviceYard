import { log } from "../../src/telemetry/log";
import { withSpan } from "../../src/telemetry/tracer";
import { startTestTracing } from "../helpers/otelTestProvider";

let written: string[];
let errSpy: jest.SpyInstance;
let outSpy: jest.SpyInstance;

beforeEach(() => {
  written = [];
  errSpy = jest.spyOn(console, "error").mockImplementation((line) => {
    written.push(String(line));
  });
  outSpy = jest.spyOn(console, "log").mockImplementation((line) => {
    written.push(String(line));
  });
});

afterEach(() => {
  errSpy.mockRestore();
  outSpy.mockRestore();
});

test("error writes one JSON line carrying msg and fields", () => {
  log.error("job failed", { jobId: "j-1" });
  expect(written).toHaveLength(1);
  const parsed = JSON.parse(written[0]);
  expect(parsed.msg).toBe("job failed");
  expect(parsed.jobId).toBe("j-1");
});

test("severity is recorded on the line", () => {
  log.warn("something odd", {});
  expect(JSON.parse(written[0]).severity).toBe("WARN");
});

test("info goes to stdout and error goes to stderr", () => {
  log.info("listening", {});
  expect(outSpy).toHaveBeenCalledTimes(1);
  expect(errSpy).not.toHaveBeenCalled();

  log.error("broke", {});
  expect(errSpy).toHaveBeenCalledTimes(1);
});

test("secret-named fields are redacted before the line is written", () => {
  log.error("job failed", { API_TOKEN: "s3cr3t" });
  expect(written[0]).not.toContain("s3cr3t");
});

test("logging works with no fields at all", () => {
  log.info("plain");
  expect(JSON.parse(written[0]).msg).toBe("plain");
});

test("a field named msg cannot overwrite the message", () => {
  log.error("real message", { msg: "impostor" });
  expect(JSON.parse(written[0]).msg).toBe("real message");
});

test("no trace ids are attached outside a span", () => {
  log.info("no span here");
  const parsed = JSON.parse(written[0]);
  expect(parsed.trace_id).toBeUndefined();
  expect(parsed.span_id).toBeUndefined();
});

/**
 * The whole point of writing each record twice: the stdout line journald
 * keeps must be correlatable to a trace on its own, because stdout is what
 * survives when the collector is unreachable.
 */
test("a line logged inside a span carries that span's ids on stdout", async () => {
  const { stop } = startTestTracing();
  try {
    await withSpan("job", {}, async () => {
      log.info("inside a span");
    });
  } finally {
    stop();
  }

  const parsed = JSON.parse(written[0]);
  expect(parsed.trace_id).toMatch(/^[0-9a-f]{32}$/);
  expect(parsed.span_id).toMatch(/^[0-9a-f]{16}$/);
});
