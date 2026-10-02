import fs from "fs";
import os from "os";
import path from "path";
import type { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { startTestTracing } from "../helpers/otelTestProvider";
import { openDatabase, setDbTracing, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";

let exporter: InMemorySpanExporter;
let stop: () => void;
let dir: string;
let db: Db | undefined;

beforeEach(() => {
  ({ exporter, stop } = startTestTracing());
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-db-"));
});

afterEach(() => {
  db?.close();
  db = undefined;
  setDbTracing(false);
  fs.rmSync(dir, { recursive: true, force: true });
  stop();
});

function dbSpans() {
  return exporter.getFinishedSpans().filter((s) => s.name.startsWith("db."));
}

test("no db spans are produced by default", () => {
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  db.all("SELECT 1");

  expect(dbSpans()).toHaveLength(0);
});

test("db spans appear once tracing is switched on", () => {
  setDbTracing(true);
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  exporter.reset();
  db.all("SELECT 1");

  const spans = dbSpans();
  expect(spans.length).toBeGreaterThan(0);
  expect(spans[0].attributes["db.system"]).toBe("sqlite");
  expect(spans[0].attributes["db.operation"]).toBe("all");
});

test("statement text is recorded but bound parameters never are", () => {
  setDbTracing(true);
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  exporter.reset();
  db.all("SELECT * FROM jobs WHERE id = ?", "super-secret-job-id");

  const span = dbSpans()[0];
  expect(String(span.attributes["db.statement"])).toContain("SELECT * FROM jobs");
  expect(JSON.stringify(span.attributes)).not.toContain("super-secret-job-id");
});

test("switching tracing back off stops producing spans", () => {
  setDbTracing(true);
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  setDbTracing(false);
  exporter.reset();
  db.all("SELECT 1");

  expect(dbSpans()).toHaveLength(0);
});
