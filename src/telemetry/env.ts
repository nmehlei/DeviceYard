/**
 * Telemetry configuration is read here rather than in src/config.ts, and that
 * exception is deliberate: the SDK must start at import time, before
 * bootstrap() ever calls loadConfig(). Copying the standard OTEL_* names into
 * Config would also duplicate variables the SDK reads natively, letting the
 * two readings drift.
 */
export interface TelemetryConfig {
  /** OTLP/HTTP endpoint. Presence of this is what enables telemetry at all. */
  endpoint: string;
  serviceName: string;
  /** node:sqlite is synchronous and a query costs microseconds, so span
   * creation can cost more than the work it measures. Off unless someone is
   * actively chasing a query problem. */
  traceDb: boolean;
}

export const DEFAULT_SERVICE_NAME = "mobile-device-farm";

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Returns null when telemetry is disabled. Absent means absent: no SDK, no
 * exporter, no background timer, and behaviour identical to before this
 * feature existed. */
export function readTelemetryEnv(env: NodeJS.ProcessEnv): TelemetryConfig | null {
  const endpoint =
    nonEmpty(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) ?? nonEmpty(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  if (!endpoint) return null;

  const traceDb = env.OTEL_TRACE_DB === "1" || env.OTEL_TRACE_DB === "true";

  return {
    endpoint,
    serviceName: nonEmpty(env.OTEL_SERVICE_NAME) ?? DEFAULT_SERVICE_NAME,
    traceDb,
  };
}
