# Observability

The farm can emit OpenTelemetry traces over OTLP/HTTP to any collector. It is
**off by default** and configured entirely through the standard `OTEL_*`
environment variables, so it works with any backend — this repo assumes none.

## Turning it on

Set an endpoint. That is the whole switch:

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

With no endpoint set, no SDK is constructed, no exporter starts and no
background timer runs. A deployment not using telemetry behaves exactly as it
did before the feature existed.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | — | OTLP/HTTP base endpoint. Setting it is what enables telemetry. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | no | — | Traces-only endpoint. Takes precedence over the general one. |
| `OTEL_SERVICE_NAME` | no | `mobile-device-farm` | `service.name` on every span. |
| `OTEL_TRACE_DB` | no | off | `1` or `true` adds a span per SQLite query. Off by default: `node:sqlite` is synchronous and a query costs microseconds, so span creation can cost more than the work it measures. Turn it on while chasing a query problem, not permanently. |

## What is emitted

Traces, structured logs and metrics. `service.version` is read from
`BUILD_INFO`, so it reports what is actually deployed rather than what was
compiled — the two differ on a rollback.

### Traces

Inbound HTTP spans and Express routing, plus the job pipeline:

```
POST /run                          instrumentation-express
└── job                            job.id, device.id, app.id,
    │                              flow.count, job.outcome
    ├── device.prepare
    ├── apk.install
    ├── archive.extract
    └── flow.run                   one per flow: flow.name, flow.index
        └── maestro.exec           process.exit_code
```

Temp-file cleanup is deliberately not traced. It runs twice on the abort
path, and wrapping it added enough async machinery for its trailing log to
land after a test had finished — instrumentation that shifts timing enough
to change behaviour has failed its own rule, and a span over file deletion
was the least useful one in the tree.

A job continues the trace of the request that submitted it, rather than
starting its own. The queue runs a job as a continuation of the *previous*
job's promise, so the submitting request's context is bound explicitly when
work is enqueued — without that, a CI run and the job it triggered would be
two disconnected traces with nothing that looks broken.

Express **middleware** layers are not instrumented. Left on, a single 401
produced twelve spans — one per middleware plus one per unmatched router —
which is the noise this project avoided the auto-instrumentation
meta-package to escape. Router and request-handler spans stay, because they
carry `http.route`.

`job.outcome` is the verdict, not the row status. A job whose flows failed
still closes as `done`; its outcome is `failed`. An unexpected throw records
`error`.

### Logs

Every log line is written twice: a JSON line on stdout for `journalctl`, and
an OTLP record. `trace_id` and `span_id` are stamped into **both**, so a
journald line found by grep is still traceable — and stdout remains the
source of truth when the collector is unreachable, which is exactly when
someone is debugging.

Message strings and field names are unchanged from before this feature, so
existing `journalctl` greps keep working.

### Metrics

| Name | Type | Unit | Attributes |
| --- | --- | --- | --- |
| `farm.jobs.submitted` | counter | — | `org` |
| `farm.jobs.completed` | counter | — | `org`, `outcome` |
| `farm.job.duration` | histogram | s | `outcome` |
| `farm.job.queue_wait` | histogram | s | — |
| `farm.flows.run` | counter | — | `outcome` |
| `farm.retention.evicted` | counter | — | — |
| `farm.queue.depth` | gauge | jobs | — |
| `farm.artifacts.bytes` | gauge | bytes | — |

HTTP server metrics come from `instrumentation-http`.

⚠️ **`job.id` is never a metric attribute**, and the recording helpers'
signatures are what enforce that rather than a convention. `org` and
`device.id` are bounded sets and safe; a per-job label would create a new
time series on every run, for ever, and eventually cost real money on any
backend. Per-job detail belongs on spans, which is what they are for.

`GET /api/jobs/:id/events` is deliberately not traced. It is a long-lived SSE
stream, and its span would stay open for as long as a dashboard tab is,
distorting traces and holding memory.

`device.id` is not a resource attribute. It changes at runtime via the devices
table, so it belongs on individual spans rather than on the process.

SQLite spans are off unless `OTEL_TRACE_DB` is set — see the table above for
why.

## What is redacted

Telemetry is an export path to a third-party system, so it applies the same
secret-masking rules the farm already uses for stored artifacts, from the same
source — `isSecretKey` in `shared/env.ts`. A second copy of the marker list is
how the two would come to disagree.

- `env` keys are recorded; `env` values matching the secret naming convention
  (`PASSWORD`, `TOKEN`, `SECRET`, `API_KEY`, `APIKEY`) are not.
- `Authorization`, `Cookie` and related headers are replaced before export.
- The `maestro` command line is **never** recorded — its arguments carry
  `-e KEY=VALUE` pairs, which is precisely where the secrets are.
- SQL statement text may be recorded; bound parameters never are.

## Shutdown

On `SIGTERM` or `SIGINT` the service stops accepting requests, stops its
background workers, then flushes buffered telemetry before exiting.

The flush is bounded, and bounded twice — inside the exporter and again around
it. A collector that is down or slow cannot hold a deploy open waiting for
`SIGKILL`.

## Verifying the export path

```bash
npm run build && npm run test:otel-smoke
```

This stands up a throwaway HTTP server, points the real exporter at it and
asserts a real payload arrives. It runs under plain `node` rather than Jest
because the OTLP exporter loads its agent factory through a dynamic `import()`,
which Jest's CommonJS VM refuses. CI runs it as its own step.
