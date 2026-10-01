import { readTelemetryEnv } from "../../src/telemetry/env";

test("absent endpoint disables telemetry", () => {
  expect(readTelemetryEnv({})).toBeNull();
});

test("an empty endpoint disables telemetry", () => {
  expect(readTelemetryEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "" })).toBeNull();
});

test("a whitespace-only endpoint disables telemetry", () => {
  expect(readTelemetryEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "   " })).toBeNull();
});

test("a general endpoint enables telemetry", () => {
  const cfg = readTelemetryEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" });
  expect(cfg).not.toBeNull();
  expect(cfg!.endpoint).toBe("http://collector:4318");
});

test("a signal-specific traces endpoint alone enables telemetry", () => {
  const cfg = readTelemetryEnv({
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector:4318/v1/traces",
  });
  expect(cfg).not.toBeNull();
  expect(cfg!.endpoint).toBe("http://collector:4318/v1/traces");
});

test("the signal-specific endpoint wins over the general one", () => {
  const cfg = readTelemetryEnv({
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://general:4318",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://traces:4318/v1/traces",
  });
  expect(cfg!.endpoint).toBe("http://traces:4318/v1/traces");
});

test("service name defaults to mobile-device-farm", () => {
  const cfg = readTelemetryEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" });
  expect(cfg!.serviceName).toBe("mobile-device-farm");
});

test("OTEL_SERVICE_NAME overrides the default", () => {
  const cfg = readTelemetryEnv({
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318",
    OTEL_SERVICE_NAME: "farm-staging",
  });
  expect(cfg!.serviceName).toBe("farm-staging");
});

test("db spans are off unless OTEL_TRACE_DB is 1 or true", () => {
  const base = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" };
  expect(readTelemetryEnv(base)!.traceDb).toBe(false);
  expect(readTelemetryEnv({ ...base, OTEL_TRACE_DB: "0" })!.traceDb).toBe(false);
  expect(readTelemetryEnv({ ...base, OTEL_TRACE_DB: "1" })!.traceDb).toBe(true);
  expect(readTelemetryEnv({ ...base, OTEL_TRACE_DB: "true" })!.traceDb).toBe(true);
});
