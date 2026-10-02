import { ExpressLayerType } from "@opentelemetry/instrumentation-express";
import {
  shouldIgnoreRequest,
  buildResource,
  expressInstrumentationConfig,
} from "../../src/telemetry/sdk";

test("SSE event streams are ignored so their spans cannot stay open", () => {
  expect(shouldIgnoreRequest("/api/jobs/abc123/events")).toBe(true);
});

test("ordinary API requests are not ignored", () => {
  expect(shouldIgnoreRequest("/api/jobs/abc123")).toBe(false);
  expect(shouldIgnoreRequest("/run")).toBe(false);
});

test("a query string does not defeat the SSE match", () => {
  expect(shouldIgnoreRequest("/api/jobs/abc123/events?since=4")).toBe(true);
});

test("an undefined url is not ignored", () => {
  expect(shouldIgnoreRequest(undefined)).toBe(false);
});

test("the resource reports the deployed version and service identity", () => {
  const attrs = buildResource("mobile-device-farm", "0.1.72", "farm-host-1");
  expect(attrs["service.name"]).toBe("mobile-device-farm");
  expect(attrs["service.version"]).toBe("0.1.72");
  expect(attrs["service.instance.id"]).toBe("farm-host-1");
});

test("device.id is not a resource attribute - it changes at runtime", () => {
  const attrs = buildResource("mobile-device-farm", "0.1.72", "farm-host-1");
  expect(attrs["device.id"]).toBeUndefined();
});

/** Measured against a running server: leaving middleware layers instrumented
 * produced twelve spans for one 401 - the exact noise this phase rejected the
 * auto-instrumentation meta-package for. */
test("express middleware layers are not instrumented", () => {
  expect(expressInstrumentationConfig().ignoreLayersType).toContain(ExpressLayerType.MIDDLEWARE);
});

test("router and request-handler layers stay instrumented - they carry http.route", () => {
  const ignored = expressInstrumentationConfig().ignoreLayersType;
  expect(ignored).not.toContain(ExpressLayerType.ROUTER);
  expect(ignored).not.toContain(ExpressLayerType.REQUEST_HANDLER);
});
