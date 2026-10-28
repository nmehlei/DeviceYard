// MUST be the first import: instrumentation-http patches the http module at
// require time, so the SDK has to start before express is required. Moving
// this line below another import silently disables HTTP tracing - the service
// stays healthy and simply reports nothing. tests/telemetry/registerOrder.test.ts
// guards it.
import "./telemetry/register";
import {communityRuntime} from './editions/runtime';
import { activeSession } from "./telemetry/register";
import type { TelemetrySession } from "./telemetry/sdk";
import fs from "fs";
import path from "path";
import type { ServerHandle } from "./server";
import type { EditionFactory } from './editions/runtime';
import { log } from "./telemetry/log";
import { loadConfig, type Config } from "./config";
import { openDatabase, setDbTracing } from "./db/driver";
import { readTelemetryEnv } from "./telemetry/env";
import { migrate } from "./db/migrations";
import { createServer } from "./server";
import { startRetentionSweep } from "./retention";
import { JobRepository } from "./store/jobRepository";
import { cleanUpFarmProfilesAtStartup } from "./workProfiles";
import { DeviceRepository } from "./store/deviceRepository";
import { UserRepository } from "./store/userRepository";
import { OrgRepository } from "./store/orgRepository";
import { OrgTokenRepository } from "./store/orgTokenRepository";
import { UserTokenRepository } from "./store/userTokenRepository";
import { NotificationStore } from "./notifications/store";
import { NotificationWorker, startNotificationWorker } from "./notifications/worker";
import { createSmtpTransport } from "./notifications/transport";
import { DeviceHealthMonitor, startDeviceHealthMonitor } from "./notifications/health";
import { JobInputsStore } from './store/jobInputs';

export function bootstrap(env: NodeJS.ProcessEnv = process.env, editionFactory?:EditionFactory): {
  app: ServerHandle;
  config: Config;
  repo: JobRepository;
  stopNotifications: () => void;
  /** Clears the scheduler's backstop tick. Wired into the SIGTERM path beside
   * stopNotifications - not because a live interval would hold the process
   * open (the Scheduler's constructor unref()s that timer, so it never
   * does), but for deterministic teardown: once shutdown starts, nothing
   * should still be ticking and dispatching new work during the drain. */
  stopScheduler: () => void;
} {
  const config = loadConfig(env);

  // Read from the same OTEL_* environment the SDK uses, not from Config -
  // see src/telemetry/env.ts for why telemetry configuration lives apart.
  setDbTracing(readTelemetryEnv(env)?.traceDb ?? false);

  let db: ReturnType<typeof openDatabase>;
  try {
    db = openDatabase(`${config.dataDir}/farm.db`);
    migrate(db);
  } catch (err) {
    // openDatabase creates DATA_DIR recursively, so first boot only succeeds
    // if the service user can write the parent directory. Left unguarded,
    // that failure surfaces as a raw EACCES stack with no hint of which
    // directory or env var is at fault - the design spec promised this is
    // "fatal with a clear message". Name DATA_DIR and include the underlying
    // message, but never any secret (there is none in this path).
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `could not create or open the database under DATA_DIR (${config.dataDir}): ${message}`
    );
  }
  const repo = new JobRepository(db);
  const deviceRepo = new DeviceRepository(db);
  // Only ever inserts on the very first boot after this feature shipped -
  // see DeviceRepository.seedIfEmpty. Keeps an existing deployment's single
  // configured device showing up as a row without a manual migration step.
  deviceRepo.seedIfEmpty(config.deviceId);

  const userRepo = new UserRepository(db);
  const orgRepo = new OrgRepository(db);
  const orgTokenRepo = new OrgTokenRepository(db, config.tokenEncryptionKey);
  const userTokenRepo = new UserTokenRepository(db, config.tokenEncryptionKey);
  const notificationStore = new NotificationStore(db, config.tokenEncryptionKey);

  // Same one-time-only precedent as deviceRepo.seedIfEmpty above. Order
  // matters: the admin user must exist before seedIfEmpty(names, adminId)
  // can add it as every seeded org's first member.
  userRepo.seedIfEmpty(config.adminUsername, config.adminEmail, config.adminPassword);
  const bootstrapAdmin = userRepo.getByUsername(config.adminUsername);
  // orgTokenRepo.seedIfEmpty must only ever fire on the orgs table's actual
  // first-ever population, not whenever org_tokens *happens* to be empty
  // right now - an operator revoking the system's only token legitimately
  // drives org_tokens back to zero rows, and gating on that would silently
  // resurrect the legacy TOKENS_JSON token on the next restart (this
  // service restarts on every merge to main). isFirstOrgBoot is read
  // before orgRepo.seedIfEmpty runs, so it reflects "was orgs empty before
  // this boot's seeding," which only ever happens once.
  const isFirstOrgBoot = orgRepo.list().length === 0;
  if (bootstrapAdmin) {
    orgRepo.seedIfEmpty(Object.keys(config.tokensByOrg), bootstrapAdmin.id);
    if (isFirstOrgBoot) {
      orgTokenRepo.seedIfEmpty(config.tokensByOrg, (name) => orgRepo.getByName(name)?.id);
    }
  }

  // The update timer restarts this service on every merge to main, so anything
  // left running belongs to a process that no longer exists. Close it before
  // the server accepts requests, or the dashboard shows permanent zombies.
  const closed = repo.reconcileInterrupted();
  if (closed > 0) {
    log.info("closed jobs interrupted by restart", { count: closed });
  }

  // Old releases had transient uploads. Preserve new durable jobs and close
  // only legacy/incomplete payloads before dispatch; cleanup runs at boot only.
  const inputs = new JobInputsStore(config.dataDir);
  repo.failQueuedWithoutPayload(id => inputs.hasPayload(id));
  inputs.reconcile(id => {
    const status = repo.getJob(id)?.status;
    return status === 'queued' || status === 'running';
  });

  // Remove work profiles a crashed run left behind and record which devices
  // can isolate. Fire-and-forget: a slow or absent phone must never delay boot.
  cleanUpFarmProfilesAtStartup(deviceRepo).catch((err) =>
    log.warn("work profile startup cleanup failed", { error: (err as Error).message })
  );

  // Best-effort purge of the whole debug/ scratch tree. This is safe only
  // because nothing is running yet at boot - runJob's own per-job cleanup
  // handles debug/<jobId> while a job is live, but a process that died
  // mid-flow (the update timer restarts on every merge, exactly when jobs
  // can be running) can leave debug output behind holding real screenshots
  // that are unreferenced by the artifacts table and therefore invisible to
  // totalArtifactBytes(), the only early warning the host is filling up. A
  // failure here must log and continue, never prevent startup.
  try {
    fs.rmSync(path.join(config.dataDir, "debug"), { recursive: true, force: true });
  } catch (err) {
    log.error("failed to purge stale debug tree at boot", { err: String(err) });
  }

  // Runs immediately and then on a fixed timer - see retention.ts. A fresh
  // install has no retention_settings row, so every threshold is disabled
  // and this is a no-op until an admin saves settings from the dashboard.
  startRetentionSweep(repo, config.dataDir);

  const notification = config.notification;
  const worker = new NotificationWorker(notificationStore,
    notification.enabled ? notification.config.publicUrl.toString() : "https://example.invalid",
    notification.enabled ? createSmtpTransport(notification.config) : undefined);
  // A restart cannot establish current device state from a persisted timestamp.
  // Force a fresh probe before previously queued health messages can be claimed.
  db.run("UPDATE notification_incidents SET last_observed_at=0");
  const stopWorker = startNotificationWorker(worker);

  const app = createServer({
    editionFactory,
    deviceId: config.deviceId,
    uploadDir: config.uploadDir,
    dataDir: config.dataDir,
    sessionSecret: config.sessionSecret,
    controlFrameIntervalMs: config.controlFrameIntervalMs,
    publicDir: path.join(__dirname, "public"),
    repo,
    deviceRepo,
    userRepo,
    orgRepo,
    orgTokenRepo,
    userTokenRepo,
    notifications: { store: notificationStore, config: notification },
  });
  const stopHealth = notification.enabled
    ? startDeviceHealthMonitor(new DeviceHealthMonitor(notificationStore, undefined, app.maintenance)) : () => {};

  // Recovered queued work resumes immediately unless maintenance is active.
  app.scheduler.dispatch?.();

  return {
    app,
    config,
    repo,
    stopNotifications: () => { stopWorker(); stopHealth(); },
    stopScheduler: () => { app.scheduler.stop?.(); },
  };
}

export interface ShutdownDeps {
  closeServer(): Promise<void>;
  /** Optional so a caller without a notification worker - a test, or a build
   * from before notifications existed - still shuts down correctly. */
  stopNotifications?: () => void;
  /** Optional for the same reason as stopNotifications: a caller without a
   * scheduler - a test, or a build from before the scheduler existed - still
   * shuts down correctly. */
  stopScheduler?: () => void;
  session: TelemetrySession | null;
  timeoutMs?: number;
}

/**
 * Until this existed the service had no SIGTERM handler at all: a deploy
 * killed it outright and discarded whatever was buffered - which for
 * telemetry is exactly the window before a restart, the part worth having.
 *
 * Order matters. Stop accepting work, stop the background workers, then
 * flush - flushing first would miss whatever those two steps emit. Every
 * step is isolated: one failing must not prevent the others, or a bug in
 * cleanup becomes a hang on every deploy.
 */
export function shutdownHandlers(deps: ShutdownDeps): () => Promise<void> {
  return async () => {
    try {
      await deps.closeServer();
    } catch (err) {
      log.error("error closing server", { err: String(err) });
    }
    try {
      deps.stopNotifications?.();
    } catch (err) {
      log.error("error stopping notifications", { err: String(err) });
    }
    try {
      deps.stopScheduler?.();
    } catch (err) {
      log.error("error stopping scheduler", { err: String(err) });
    }
    if (deps.session) {
      const timeoutMs = deps.timeoutMs ?? 5000;
      try {
        // Bounded HERE as well as inside the session. This function is what
        // promises a deploy is never held open, so it must not depend on the
        // flush honouring its own timeout - a hung exporter would otherwise
        // block systemd until it resorted to SIGKILL.
        await Promise.race([
          deps.session.shutdown(timeoutMs),
          new Promise<void>((resolve) => {
            setTimeout(resolve, timeoutMs).unref();
          }),
        ]);
      } catch (err) {
        log.error("error flushing telemetry", { err: String(err) });
      }
    }
  };
}

/** Boots the service and starts listening.
 *
 * Exported deliberately. The compiled entrypoint moved to dist/src/index.js
 * when shared/ joined the compilation, but NME-IaC's systemd unit hardcodes
 * dist/index.js, so ci/package.sh writes a one-line forwarder there. A
 * forwarder means this file is no longer the main module - `require.main ===
 * module` is false - so a guard alone would load everything, start nothing,
 * and exit 0. That is precisely what happened to 0.1.50: the service ran for
 * 1.274s, exited "successfully", and the farm served 502 until it was fixed.
 *
 * Anything that wants to run the service calls this. The guard below stays so
 * `node dist/src/index.js` still works directly. */
export function main(editionFactory:EditionFactory = communityRuntime): void {
  const { app, config, stopNotifications, stopScheduler } = bootstrap(process.env,editionFactory);
  const server = app.listen(config.port, () => {
    log.info("DeviceYard runner listening", {
      port: config.port,
      deviceId: config.deviceId,
      dataDir: config.dataDir,
    });
  });

  // The live-view socket needs the http.Server, which only exists here.
  server.on("upgrade", (req, socket, head) => app.control.handleUpgrade(req, socket, head));

  const shutdown = shutdownHandlers({
    closeServer: () =>
      new Promise<void>((resolve) => {
        // server.close() waits for open connections to end, and a live-view
        // socket never ends on its own - without this, a drain would hang
        // until systemd's timeout for as long as anyone had the page open.
        app.control.close();
        server.close(() => resolve());
      }),
    stopNotifications,
    stopScheduler,
    session: activeSession(),
  });

  // once(), not on(): a second SIGTERM during a drain must not start a second
  // shutdown on top of the one already running.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void shutdown().then(() => process.exit(0));
    });
  }
}

if (require.main === module) {
  main();
}
