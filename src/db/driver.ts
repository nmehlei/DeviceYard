import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { trace } from "@opentelemetry/api";

/**
 * The only file in this repo that knows which SQLite binding is in use.
 *
 * `node:sqlite` ships with Node 22, which means the deploy bundle stays free
 * of native modules - `ci/package.sh` builds node_modules on the ADO agent and
 * unpacks it on the farm host, so a native binding would couple those two
 * machines' platform and Node ABI. Swapping to better-sqlite3 later means
 * rewriting this file and nothing else; both expose the same synchronous
 * prepare/run/all shape.
 */
export interface Db {
  exec(sql: string): void;
  run(sql: string, ...params: unknown[]): void;
  all<T>(sql: string, ...params: unknown[]): T[];
  get<T>(sql: string, ...params: unknown[]): T | undefined;
  close(): void;
}

type SqlParam = string | number | bigint | null | Uint8Array;

function toSqlParams(params: unknown[]): SqlParam[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    return p as SqlParam;
  });
}

/**
 * Off by default. node:sqlite is synchronous and embedded: a typical query
 * costs microseconds, so creating a span can cost more than the work it
 * measures. Switched on by OTEL_TRACE_DB while someone is actually chasing a
 * query problem, not permanently.
 */
let dbTracingEnabled = false;

export function setDbTracing(enabled: boolean): void {
  dbTracingEnabled = enabled;
}

/**
 * withSpan is deliberately not used here: these calls are synchronous, and
 * wrapping them in a promise would change this driver's synchronous contract,
 * which the comment at the top of this file documents as intentional.
 *
 * Statement text is safe and useful; bound parameters are not recorded - they
 * carry job ids, emails and whatever else a caller passed.
 */
function traced<T>(operation: string, sql: string, fn: () => T): T {
  if (!dbTracingEnabled) return fn();
  return trace
    .getTracer("mobile-device-farm")
    .startActiveSpan(
      `db.${operation}`,
      { attributes: { "db.system": "sqlite", "db.operation": operation, "db.statement": sql } },
      (span) => {
        try {
          return fn();
        } finally {
          span.end();
        }
      }
    );
}

export function openDatabase(filePath: string): Db {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const handle = new DatabaseSync(filePath);

  // WAL keeps SSE readers from blocking the job writer. NORMAL synchronous is
  // the usual WAL companion: durable across process crashes, which is the case
  // that matters here (the update timer restarts this service on every merge).
  handle.exec("PRAGMA journal_mode = WAL");
  handle.exec("PRAGMA synchronous = NORMAL");
  handle.exec("PRAGMA foreign_keys = ON");

  return {
    exec: (sql) => traced("exec", sql, () => handle.exec(sql)),
    run: (sql, ...params) => {
      traced("run", sql, () => {
        handle.prepare(sql).run(...toSqlParams(params));
      });
    },
    all: <T>(sql: string, ...params: unknown[]) =>
      traced("all", sql, () => handle.prepare(sql).all(...toSqlParams(params)) as T[]),
    get: <T>(sql: string, ...params: unknown[]) =>
      traced("get", sql, () => handle.prepare(sql).get(...toSqlParams(params)) as T | undefined),
    close: () => handle.close(),
  };
}
