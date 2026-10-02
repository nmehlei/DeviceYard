import os from "os";
import { readTelemetryEnv } from "./env";
import { startTelemetry, type TelemetrySession } from "./sdk";
import { readVersion } from "../version";

/**
 * Side-effect module. Imported FIRST by src/index.ts because
 * instrumentation-http patches the http module at require time - starting the
 * SDK after express is required means no HTTP spans, silently.
 *
 * With no endpoint configured this does nothing at all: no SDK, no exporter,
 * no background timer. A deployment that is not using telemetry gets exactly
 * the behaviour it had before this module existed.
 */
let session: TelemetrySession | null = null;

const cfg = readTelemetryEnv(process.env);
if (cfg) {
  session = startTelemetry(cfg, readVersion(), os.hostname());
}

/** Null when telemetry is disabled. The shutdown handler uses this. */
export function activeSession(): TelemetrySession | null {
  return session;
}
