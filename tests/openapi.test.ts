import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SwaggerParser from "@apidevtools/swagger-parser";
import request from "supertest";
import { createServer } from "../src/server";
import { buildOpenApiDocument } from "../src/openapi/document";
import { openDatabase, type Db } from "../src/db/driver";
import { migrate } from "../src/db/migrations";
import { JobRepository } from "../src/store/jobRepository";
import { DeviceRepository } from "../src/store/deviceRepository";
import { UserRepository } from "../src/store/userRepository";
import { OrgRepository } from "../src/store/orgRepository";
import { OrgTokenRepository } from "../src/store/orgTokenRepository";
import { UserTokenRepository } from "../src/store/userTokenRepository";
import { NotificationStore } from "../src/notifications/store";

type ExpressLayer = {
  route?: { path: unknown; methods: Record<string, boolean> };
  handle?: { stack?: ExpressLayer[] };
};

const API_ROOTS = new Set(["/run", "/run/:id", "/jobs", "/status", "/openapi.json"]);

function runtimeOperations(stack: ExpressLayer[]): string[] {
  const result: string[] = [];
  for (const layer of stack) {
    if (layer.route && typeof layer.route.path === "string") {
      const routePath = layer.route.path;
      if (routePath.startsWith("/api/") || API_ROOTS.has(routePath)) {
        for (const method of Object.keys(layer.route.methods).filter((key) => layer.route!.methods[key])) {
          result.push(`${method.toUpperCase()} ${routePath.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`);
        }
      }
    }
    if (layer.handle?.stack) result.push(...runtimeOperations(layer.handle.stack));
  }
  return result.sort();
}

function documentedOperations(): string[] {
  const methods = new Set(["get", "put", "post", "delete", "patch", "options", "head", "trace"]);
  return Object.entries(buildOpenApiDocument("test").paths ?? {}).flatMap(([routePath, item]) =>
    Object.keys(item ?? {})
      .filter((key) => methods.has(key))
      .map((method) => `${method.toUpperCase()} ${routePath}`)
  ).sort();
}

describe("public OpenAPI document", () => {
  let dir: string;
  let db: Db | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function app() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "deviceyard-openapi-"));
    const database = openDatabase(path.join(dir, "farm.db"));
    db = database;
    migrate(database);
    const repo = new JobRepository(database);
    const deviceRepo = new DeviceRepository(database);
    const userRepo = new UserRepository(database);
    const orgRepo = new OrgRepository(database);
    const key = "00".repeat(32);
    return createServer({
      sessionSecret: "openapi-test-session-secret",
      deviceId: "test-device",
      deviceRepo,
      userRepo,
      orgRepo,
      orgTokenRepo: new OrgTokenRepository(database, key),
      userTokenRepo: new UserTokenRepository(database, key),
      repo,
      dataDir: dir,
      publicDir: path.join(dir, "public"),
      notifications: {
        store: new NotificationStore(database, key),
        config: { enabled: false, status: "disabled" },
      },
    });
  }

  test("is available without authentication", async () => {
    const response = await request(app()).get("/openapi.json");

    expect(response.status).toBe(200);
    expect(response.type).toBe("application/json");
    expect(response.headers["cache-control"]).toBe("public, max-age=300");
    expect(response.body.openapi).toBe("3.1.0");
    expect(typeof response.body.info.version).toBe("string");
    expect(response.body.paths["/run"].post).toBeDefined();
    expect(response.body.paths["/api/jobs/{id}"].get).toBeDefined();
  });

  test("has a self-hosted browser viewer with access to the raw document", async () => {
    const server = app();
    const response = await request(server).get("/api-docs");
    const asset = await request(server).get("/api-docs/assets/swagger-ui.css");

    expect(response.status).toBe(200);
    expect(response.type).toBe("text/html");
    expect(response.text).toContain('url: "/openapi.json"');
    expect(response.text).toContain('href="/openapi.json">Raw OpenAPI JSON</a>');
    expect(asset.status).toBe(200);
    expect(asset.type).toBe("text/css");
  });

  test("is structurally valid OpenAPI", async () => {
    await expect(SwaggerParser.validate(buildOpenApiDocument("1.2.3"))).resolves.toBeDefined();
  });

  test("matches every API route registered by the real Express server", () => {
    const server = app() as unknown as { _router: { stack: ExpressLayer[] } };
    const runtime = runtimeOperations(server._router.stack);
    const documented = documentedOperations();

    expect({
      undocumented: runtime.filter((operation) => !documented.includes(operation)),
      stale: documented.filter((operation) => !runtime.includes(operation)),
    }).toEqual({ undocumented: [], stale: [] });
  });

  test("is deterministic for a given deployed version", () => {
    expect(buildOpenApiDocument("1.2.3")).toEqual(buildOpenApiDocument("1.2.3"));
  });
});
