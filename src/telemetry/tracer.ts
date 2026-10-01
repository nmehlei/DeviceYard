import { SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
import { redactAttributes, redactText } from "./redact";

const TRACER_NAME = "mobile-device-farm";

/**
 * The only tracing API domain code touches.
 *
 * Two rules it exists to enforce. Attributes go through redactAttributes, so
 * no caller has to remember that telemetry is an export path. And a throwing
 * callback rethrows the ORIGINAL error unchanged - instrumentation that
 * alters control flow is worse than no instrumentation, because it turns an
 * observability feature into an outage.
 *
 * When telemetry is disabled the global tracer provider is the no-op one, so
 * this costs an object allocation and nothing else.
 */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, unknown>,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, async (span) => {
    span.setAttributes(redactAttributes(attrs) as Attributes);
    try {
      return await fn(span);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: redactText(message) });
      span.recordException({ message: redactText(message) });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Stamped into every log line - including the stdout one - so a journald
 * record found by grep can still be traced when the collector was down. */
export function currentTraceIds(): { trace_id?: string; span_id?: string } {
  const ctx = trace.getActiveSpan()?.spanContext();
  if (!ctx) return {};
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}
