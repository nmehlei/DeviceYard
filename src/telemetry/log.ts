import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { currentTraceIds } from "./tracer";
import { redactAttributes } from "./redact";

type Severity = "INFO" | "WARN" | "ERROR";

const SEVERITY_NUMBER: Record<Severity, SeverityNumber> = {
  INFO: SeverityNumber.INFO,
  WARN: SeverityNumber.WARN,
  ERROR: SeverityNumber.ERROR,
};

/**
 * Every record is written twice, and that duplication is the point.
 *
 * The stdout line is what journalctl reads, and it stays the source of truth
 * when the collector is unreachable - which is exactly when someone is
 * debugging. The OTLP record is what makes logs searchable next to traces.
 * trace_id and span_id go into BOTH, so a journald line found by grep is
 * still traceable.
 *
 * Field names match the console.* call sites this replaced, exactly.
 * Operators have greps against `msg` and `jobId`; renaming them would break
 * tooling this change is not entitled to touch.
 */
function emit(severity: Severity, msg: string, fields: Record<string, unknown> = {}): void {
  const attributes = { ...redactAttributes(fields), ...currentTraceIds() };

  // `msg` and `severity` are written last so a caller-supplied field can
  // never displace them - a log line that lies about what happened is worse
  // than a dropped field.
  const line = JSON.stringify({ ...attributes, severity, msg });
  if (severity === "INFO") {
    console.log(line);
  } else {
    console.error(line);
  }

  // A no-op logger provider when telemetry is disabled, so this costs nothing.
  logs.getLogger("mobile-device-farm").emit({
    severityNumber: SEVERITY_NUMBER[severity],
    severityText: severity,
    body: msg,
    attributes: attributes as Record<string, string>,
  });
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => emit("INFO", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("WARN", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("ERROR", msg, fields),
};
