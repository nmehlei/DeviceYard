import { NodeSDK } from "@opentelemetry/sdk-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { ExpressInstrumentation, ExpressLayerType } from "@opentelemetry/instrumentation-express";
import type { TelemetryConfig } from "./env";
import { REDACTED } from "../env";

export interface TelemetrySession {
  /** Flushes buffered spans and stops the SDK. Bounded: a collector that is
   * down must never hold the process open through a deploy. */
  shutdown(timeoutMs?: number): Promise<void>;
}

/** GET /api/jobs/:id/events is a long-lived SSE stream. Left instrumented,
 * its span stays open for as long as a dashboard tab is - distorting traces
 * and holding memory. Connect/disconnect become a counter instead. */
export function shouldIgnoreRequest(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split("?")[0];
  return /^\/api\/jobs\/[^/]+\/events$/.test(path);
}

export interface SignalEndpoints {
  traces: string;
  logs: string;
  metrics: string;
}

/** OTEL_EXPORTER_OTLP_ENDPOINT is a base; the signal-specific variables are
 * full paths. Accept either without producing a doubled separator or a
 * doubled /v1/traces. */
export function signalEndpoints(endpoint: string): SignalEndpoints {
  const base = endpoint.replace(/\/+$/, "");
  const named = /\/v1\/(traces|logs|metrics)$/.exec(base);
  const root = named ? base.slice(0, named.index) : base;
  return {
    traces: `${root}/v1/traces`,
    logs: `${root}/v1/logs`,
    metrics: `${root}/v1/metrics`,
  };
}

/** device.id is deliberately absent: it changes at runtime via the devices
 * table, so it belongs on spans, not on the process-wide resource. */
export function buildResource(
  serviceName: string,
  version: string,
  hostname: string
): Record<string, string> {
  return {
    "service.name": serviceName,
    "service.version": version,
    "service.instance.id": hostname,
  };
}

/**
 * Measured, not guessed: without ignoring middleware layers a single 401
 * produced twelve spans - one per middleware (query, expressInit, jsonParser
 * and every anonymous handler) plus one per router the request did not match.
 * Suppressing them takes that to six and leaves http.route intact.
 *
 * That noise is the exact reason this phase rejected the auto-instrumentation
 * meta-package, so shipping it here would contradict the phase's own
 * rationale. Middleware timings are recoverable by removing this option when
 * a specific middleware is genuinely under suspicion.
 */
export function expressInstrumentationConfig(): { ignoreLayersType: ExpressLayerType[] } {
  return { ignoreLayersType: [ExpressLayerType.MIDDLEWARE] };
}

export function startTelemetry(
  cfg: TelemetryConfig,
  version: string,
  hostname: string
): TelemetrySession {
  const urls = signalEndpoints(cfg.endpoint);

  const sdk = new NodeSDK({
    resource: resourceFromAttributes(buildResource(cfg.serviceName, version, hostname)),
    traceExporter: new OTLPTraceExporter({ url: urls.traces }),
    logRecordProcessors: [
      new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: urls.logs }) }),
    ],
    // 60s: chosen back when the farm ran one job at a time and a finer
    // resolution would only have cost export volume. With concurrent jobs
    // across a device pool, a 60s bucket can now merge distinct concurrent
    // runs into one data point. Worth re-deciding now that concurrency is
    // real; not changed here.
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: urls.metrics }),
      exportIntervalMillis: 60_000,
    }),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => shouldIgnoreRequest(req.url),
        // Credentials must not leave the process on the telemetry path. The
        // exporter never sees these because they are replaced at capture.
        headersToSpanAttributes: {
          server: { requestHeaders: [], responseHeaders: [] },
          client: { requestHeaders: [], responseHeaders: [] },
        },
        applyCustomAttributesOnSpan: (span) => {
          span.setAttribute("http.request.header.authorization", REDACTED);
        },
      }),
      new ExpressInstrumentation(expressInstrumentationConfig()),
    ],
  });

  sdk.start();

  return {
    async shutdown(timeoutMs = 5000): Promise<void> {
      await Promise.race([
        sdk.shutdown(),
        new Promise<void>((resolve) => {
          setTimeout(resolve, timeoutMs).unref();
        }),
      ]);
    },
  };
}
