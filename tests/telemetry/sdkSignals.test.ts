import { signalEndpoints } from "../../src/telemetry/sdk";

test("signal paths are derived from a base endpoint", () => {
  const e = signalEndpoints("http://collector:4318");
  expect(e.traces).toBe("http://collector:4318/v1/traces");
  expect(e.logs).toBe("http://collector:4318/v1/logs");
  expect(e.metrics).toBe("http://collector:4318/v1/metrics");
});

test("a trailing slash does not produce a doubled separator", () => {
  const e = signalEndpoints("http://collector:4318/");
  expect(e.traces).toBe("http://collector:4318/v1/traces");
});

test("an endpoint that already names a signal path is used verbatim for it", () => {
  const e = signalEndpoints("http://collector:4318/v1/traces");
  expect(e.traces).toBe("http://collector:4318/v1/traces");
});

test("a signal-named endpoint still yields the sibling signal paths", () => {
  const e = signalEndpoints("http://collector:4318/v1/traces");
  expect(e.logs).toBe("http://collector:4318/v1/logs");
  expect(e.metrics).toBe("http://collector:4318/v1/metrics");
});

test("a base endpoint carrying a path prefix is preserved", () => {
  const e = signalEndpoints("http://gateway:4318/otlp");
  expect(e.traces).toBe("http://gateway:4318/otlp/v1/traces");
  expect(e.logs).toBe("http://gateway:4318/otlp/v1/logs");
});
