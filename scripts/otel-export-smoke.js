#!/usr/bin/env node
/**
 * Verifies that a recorded span actually reaches a collector over OTLP/HTTP.
 *
 * This deliberately runs under plain node rather than jest. The OTLP HTTP
 * exporter loads its agent factory through a dynamic import(), which throws
 * "A dynamic import callback was invoked without --experimental-vm-modules"
 * inside jest's CommonJS VM. Production runs under plain node, so testing it
 * there is both possible and closer to what actually ships - an in-memory
 * exporter cannot catch a wrong URL, a wrong protocol, or a serialisation
 * failure, which is the entire point of this check.
 *
 * Run after `npm run build`:  node scripts/otel-export-smoke.js
 * Exits 0 on success, 1 with a message on failure.
 */
const http = require("http");
const { trace } = require("@opentelemetry/api");
const { startTelemetry } = require("../dist/src/telemetry/sdk");

function fakeCollector() {
  const received = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          received.push(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (err) {
          received.push({ parseError: String(err) });
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1/traces`,
        received,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function fail(message) {
  console.error(`otel-export-smoke: FAIL - ${message}`);
  process.exitCode = 1;
}

async function main() {
  const collector = await fakeCollector();
  const session = startTelemetry(
    { endpoint: collector.url, serviceName: "test-farm", traceDb: false },
    "9.9.9",
    "test-host"
  );

  trace.getTracer("smoke").startSpan("smoke-span").end();

  // shutdown() forces a flush, so there is nothing to poll for.
  await session.shutdown(5000);
  await collector.close();

  if (collector.received.length === 0) {
    return fail("no OTLP payload reached the collector");
  }

  const body = JSON.stringify(collector.received[0]);
  for (const expected of ["smoke-span", "test-farm", "9.9.9"]) {
    if (!body.includes(expected)) {
      return fail(`payload did not contain ${expected}: ${body.slice(0, 400)}`);
    }
  }

  console.log("otel-export-smoke: OK - span reached the collector with its resource attributes");
}

main().catch((err) => {
  fail(String((err && err.stack) || err));
});
