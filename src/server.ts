import os from "os";
import { randomUUID } from 'node:crypto';
import { JobInputsStore } from './store/jobInputs';
import { MaintenanceCoordinator } from './maintenance/coordinator';
import { trackControlStream } from './maintenance/control';
import { maintenanceRoutes } from './api/maintenance';
import fs from "fs";
import path from "path";
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import multer from "multer";
import { parseDeviceTags } from '../shared/deviceTags';
import { parseIsolation, type IsolationMode } from '../shared/isolation';

const PER_FLOW_ISOLATION_WARNING = 'per-flow isolation creates a work profile for every flow: about 15-40 s and 1.5 GB of device writes per flow';

function waitingReasonFallback(job: { requiredDeviceTags: string[]; isolation: IsolationMode } | undefined): string | null {
  if (job?.requiredDeviceTags.length) return 'PRO_ROUTING_REQUIRED';
  return job && job.isolation !== 'disabled' ? 'PRO_ISOLATION_REQUIRED' : null;
}
import { context, type Context } from "@opentelemetry/api";
import { Scheduler } from "./scheduler";
import type { EditionFactory, EditionRuntime } from './editions/runtime';
import type { SchedulerHandle, SchedulerDeps } from './editions/scheduler';
import { editionRoutes } from './api/editions';
import { attachUserFromCookie, attachPatUser, requireAuth } from "./auth";
import { sessionRoutes } from "./api/session";
import { meRoutes } from "./api/me";
import { jobRoutes } from "./api/jobs";
import { fileRoutes } from "./api/files";
import { deviceRoutes, deviceOpsRunner } from "./api/devices";
import { orgRoutes } from "./api/orgs";
import { adminRoutes } from "./api/admin";
import { mcpClientRoutes } from "./api/mcpClient";
import { cliRoutes } from "./api/cli";
import { notificationRoutes, type NotificationDeps } from "./api/notifications";
import { accountActionRoutes } from "./api/accountActions";
import { buildOpenApiDocument } from "./openapi/document";
import { renderOpenApiViewer, swaggerUiAssetPath } from "./openapi/viewer";
import { type CommandRunner } from "./maestro";
import { parseEnvField } from "./env";
import { log } from "./telemetry/log";
import { recordJobSubmitted } from "./telemetry/metrics";
import { resolveAppIdFromApk, type AppIdResolver, AppIdResolutionError } from "./appId";
import { renderStatusPage } from "./statusPage";
import { runJob } from "./jobRunner";
import { JobEvents } from "./events";
import { captureDeviceScreenshot, type ScreenshotCapturer } from "./screenshot";
import { createFrameSource } from "./control/frames";
import { createControlUpgrade } from "./api/control";
import { ControlHub } from "./control/hub";
import { ControlLeases } from "./control/leases";
import { startScrcpyControlStream } from "./control/scrcpy";
import type { StartControlStream } from "./control/controlStream";
import type { JobRepository } from "./store/jobRepository";
import type { DeviceRepository } from "./store/deviceRepository";
import type { UserRepository } from "./store/userRepository";
import type { OrgRepository } from "./store/orgRepository";
import type { OrgTokenRepository } from "./store/orgTokenRepository";
import type { UserTokenRepository } from "./store/userTokenRepository";
import type { StepRow } from "./store/rows";
import { toLegacyJob } from "./store/legacyView";

export interface ServerDeps {
  editionFactory?: EditionFactory;
  notifications?: NotificationDeps;
  /**
   * Signs and verifies the httpOnly session cookie a browser gets from
   * POST /api/session after exchanging its org token once. Rotating this
   * value invalidates every outstanding session - the revocation mechanism
   * until there is a real sessions table.
   */
  sessionSecret: string;
  /** Seeds the devices table's first row on first-ever boot (DeviceRepository.seedIfEmpty)
   * - after that, which device jobs run against comes from the table's active row, not this
   * value. Kept required so a fresh DATA_DIR still starts usable without a manual step. */
  deviceId: string;
  deviceRepo: DeviceRepository;
  userRepo: UserRepository;
  orgRepo: OrgRepository;
  orgTokenRepo: OrgTokenRepository;
  /** Personal access tokens: one person's credential, usable across every org
   * they belong to. Separate from orgTokenRepo so the CI bearer path is
   * untouched. */
  userTokenRepo: UserTokenRepository;
  /**
   * Resolves the real app id from an uploaded APK's own manifest, so the
   * value cleared/force-stopped before every job can never drift from what's
   * actually being installed. Defaults to reading it for real via
   * app-binary-info; optional so a test that never exercises the apk's
   * actual content can inject a trivial stub instead of needing a real,
   * parseable APK on disk - same idea as the injectable CommandRunner below.
   */
  resolveAppId?: AppIdResolver;
  repo: JobRepository;
  dataDir: string;
  /**
   * Directory containing the built dashboard's static export
   * (dashboard's `out/`, copied to `dist/public` by ci/package.sh). Serves
   * the dashboard at `/`, replacing the old /status page as the site root.
   */
  publicDir?: string;
  runner?: CommandRunner;
  /** Captures one PNG frame from a device. Injected for tests exactly as
   * deviceRoutes already does, so live view needs no phone to exercise. */
  captureScreenshot?: ScreenshotCapturer;
  /** Floor between live-view captures. Production passes config's value. */
  controlFrameIntervalMs?: number;
  uploadDir?: string;
  /**
   * Per-job change notifications. runJob publishes to it after every
   * persisted state change (start, each step landing, terminal status), and
   * the SSE route in jobRoutes subscribes to push that progress to a
   * connected dashboard. Optional so tests can inject one and assert on it;
   * defaults to a fresh instance otherwise.
   */
  events?: JobEvents;
  /** Optional so a test can inject a spy or a no-op. Absent means this server
   * owns its scheduler, which is the production path. */
  scheduler?: InjectedScheduler;
  /** Starts a live control session. Tests inject a fake; production uses the
   * scrcpy adapter, which loads its ESM dependencies only when called. */
  startControlStream?: StartControlStream;
  /**
   * Overrides the scheduler's backstop tick interval; 0 disables it. Only
   * meaningful when this server builds its own scheduler.
   *
   * Left unset it is the Scheduler's own default (10s) in production and 0
   * under NODE_ENV=test - see the tickMs line in createServer for why a test
   * server must not own a live timer.
   */
  schedulerTickMs?: number;
}

/**
 * What createServer needs of a scheduler, and what it hands back.
 *
 * `submit` is all POST /run uses, so a test can inject a two-line spy.
 * `dispatch`/`stop` are what the process owner (src/index.ts) needs - dispatch
 * at boot, stop on SIGTERM - and are optional only because an injected spy is
 * not expected to have them; the production path always returns a real
 * Scheduler, which has both.
 */
export type InjectedScheduler = Pick<SchedulerHandle, "submit"> & Partial<Omit<SchedulerHandle, "submit">>;

/**
 * The app, with the scheduler it owns hanging off it.
 *
 * Not `{ app, scheduler }`: GET /run and POST /run are covered by
 * tests/contract/ciContract.test.ts, which is frozen (it guards a live CI
 * pipeline) and both calls createServer() and passes the result straight to
 * supertest. An object return would have required editing it. Returning the
 * Express app itself, carrying one extra property, keeps every one of the ~40
 * existing call sites byte-identical while still giving index.ts a handle on
 * the scheduler.
 *
 * `control` hangs off it for the same reason: the live-view socket needs the
 * http.Server that only index.ts has, and adding a second property keeps that
 * frozen test untouched where an object return would not.
 */
export type ServerHandle = Express & {
  maintenance: MaintenanceCoordinator;
  scheduler: InjectedScheduler;
  control: ReturnType<typeof createControlUpgrade>;
};

type UploadedFiles = {
  apk?: Express.Multer.File[];
  flowsArchive?: Express.Multer.File[];
};

function cleanupUploadedFiles(files: UploadedFiles | undefined): void {
  const paths = [files?.apk?.[0]?.path, files?.flowsArchive?.[0]?.path];
  for (const p of paths) {
    if (!p) continue;
    try {
      fs.unlinkSync(p);
    } catch (err) {
      log.error("failed to delete uploaded file during cleanup", { path: p, err: String(err) });
    }
  }
}

export function createServer(deps: ServerDeps): ServerHandle {
  const app = express() as ServerHandle;

  const auth = requireAuth(deps.orgTokenRepo, deps.orgRepo);
  const events = deps.events ?? new JobEvents();

  // Live view. Frames come from `screencap`, never an encoder: that is what
  // lets an admin watch a device while a job's `screenrecord` is running
  // without being able to disturb the recording.
  const captureScreenshot = deps.captureScreenshot ?? captureDeviceScreenshot;
  const controlFrameIntervalMs = deps.controlFrameIntervalMs ?? 1000;
  const controlLeases = new ControlLeases();
  const maintenance = new MaintenanceCoordinator(deps.repo);
  app.maintenance = maintenance;
  const edition:EditionRuntime|undefined = deps.editionFactory?.({deviceRepo:deps.deviceRepo,repo:deps.repo,dataDir:deps.dataDir,
    occupied:():string[]=>[...controlLeases.occupiedDeviceIds(), ...deps.deviceRepo.list().filter(d=>controlHub.viewerCount(d.id)>0).map(d=>d.id)]});

  // express.json() and sessionRoutes must be mounted before the auth-guarded
  // routes below: POST /api/session is how a browser OBTAINS a session in
  // the first place, so if it sat behind `auth` it would be unreachable and
  // login could never succeed. attachUserFromCookie runs even earlier and
  // unconditionally - it never blocks a request, only best-effort identifies
  // a person from the cookie if one is present, which GET /api/session (and
  // `auth` itself, for the cookie path) both depend on having already run.
  app.use(express.json());
  app.use(attachUserFromCookie(deps.userRepo, deps.sessionSecret));
  app.use(attachPatUser(deps.userTokenRepo));
  // Public by design: this contains contract metadata only, and clients need
  // it before they have chosen or configured an authentication mechanism.
  // Build per request so readVersion() describes the deployed bundle even
  // when createServer() is constructed before BUILD_INFO is installed.
  app.get("/openapi.json", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    const document = buildOpenApiDocument();
    res.status(200).json({...document, paths: {...document.paths, ...edition?.deviceRouting?.openapiPaths}});
  });
  // Asset URLs are stable across upgrades, so keep this cache short enough
  // that a newly deployed Swagger UI cannot be shadowed by an old browser copy.
  app.use("/api-docs/assets", express.static(swaggerUiAssetPath, { maxAge: "1h" }));
  app.get("/api-docs", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.status(200).type("html").send(renderOpenApiViewer());
  });
  app.use(sessionRoutes({ userRepo: deps.userRepo, orgRepo: deps.orgRepo, sessionSecret: deps.sessionSecret }));
  app.use(meRoutes({ orgRepo: deps.orgRepo, userTokenRepo: deps.userTokenRepo }));
  if (deps.notifications) app.use(notificationRoutes(deps.notifications));
  if (deps.notifications) app.use(accountActionRoutes(deps.notifications));

  // `adb install` refuses any file whose name does not end in .apk or .apex —
  // multer's default random filename has no extension at all, so an upload
  // would be rejected with "filename doesn't end .apk". Keep a suffix that
  // matches the field.
  const uploadRoot = deps.uploadDir ?? os.tmpdir();

  // Payload publication precedes queue insertion, so every accepted job can
  // execute after restart without its original multipart upload directory.
  const jobInputs = new JobInputsStore(deps.dataDir);
  // The submitting request's trace context, captured at submit() time and
  // applied around the runJob invocation below. Dispatch happens from three
  // places - submit(), a completing job's .finally(), and the safety tick -
  // and only the first has the right context active. Reading context.active()
  // at claim time instead would either pick up the PREVIOUS job's context (the
  // .finally() case) or nothing meaningful (the tick), so it has to travel
  // with the job like the maps above rather than be read fresh at claim time.
  const traceCtxByJob = new Map<string, Context>();

  // runJob is closed over here rather than injected into Scheduler's
  // constructor arguments one field at a time: everything below except jobId
  // and deviceId is server-scoped and constant for the process's lifetime.
  const scheduler: InjectedScheduler =
    deps.scheduler ??
    (edition?.createScheduler ?? ((options:SchedulerDeps) => new Scheduler(options)))({
      policy: edition?.policy,
      isDeviceOnline: id => maintenance.run('operation', async () => {
        const result = await (deps.runner ?? deviceOpsRunner)('adb', ['-s', id, 'get-state']);
        return result.code === 0 && result.stdout.trim() === 'device';
      }),
      repo: deps.repo,
      deviceRepo: deps.deviceRepo,
      // A test-constructed server must not own a live 10s timer. ~40 suites
      // build a server with a real repo of their own; a backstop tick firing
      // mid-test would claim and start that suite's queued jobs from outside
      // the test's own control flow, in a repo that already has a measured
      // load-related flakiness problem. Production is unaffected: NODE_ENV is
      // never "test" there, so this passes undefined and the Scheduler applies
      // its own default. Same NODE_ENV signal notifications/config.ts already
      // keys off. schedulerTickMs overrides both, for a test that wants the
      // real tick.
      tickMs: deps.schedulerTickMs ?? (process.env.NODE_ENV === "test" ? 0 : undefined),
      occupiedDeviceIds: () => controlLeases.occupiedDeviceIds(),
      // `async` is load-bearing, not stylistic. fs.mkdtempSync below can throw
      // synchronously (ENOSPC, EACCES) while the argument list is still being
      // evaluated - i.e. before runJob returns anything to attach a .finally
      // to. In an async function that throw becomes a rejection, so the
      // finally still runs and the three map entries below are still released.
      // (Scheduler also guards the synchronous case; that guard stays, but it
      // cannot clean up state it does not know about.)
      runJob: ({ jobId, deviceId }) => maintenance.trackClaimedJob(jobId, async () => {
        // First thing, before any check that can throw: the scheduler has
        // already claimed this device (claimNextQueued writes status='running'
        // and device_id), so anyone watching it should see "a job is running"
        // immediately - including for a job that turns out to be unrunnable,
        // which still occupies the device until the finally below.
        controlHub.refreshModes();
        try {
          const uploads = await jobInputs.load(jobId);
          if (!uploads) {
            // A queued row whose in-memory context is gone - a job that
            // outlived the process that accepted it. There is nothing to run:
            // its apk is gone too. Throwing lets the scheduler close it as
            // failed with this reason rather than dereferencing undefined.
            throw new Error('job inputs unavailable');
          }
          // Applied around the call, not read fresh here: the context active
          // at this point belongs to whichever dispatch triggered this claim
          // (submit(), a previous job's .finally(), or the tick), none of
          // which is necessarily the submitting request. context.with runs
          // the callback with the CAPTURED context active instead, so the
          // "job" span jobRunner opens below becomes a child of the POST /run
          // that submitted this job, not of whatever happened to be active
          // when the scheduler got around to claiming it.
          const traceCtx = traceCtxByJob.get(jobId) ?? context.active();
          await context.with(traceCtx, () =>
            runJob({
              jobId,
              deviceId,
              appId: uploads.appId,
              dataDir: deps.dataDir,
              apkPath: uploads.apkPath,
              flowsArchivePath: uploads.flowsArchivePath,
              // Extraction dirs live under uploadRoot (not the global
              // os.tmpdir()) so that a server's temp artifacts stay scoped to
              // that server. Tests configure a per-test uploadDir, which makes
              // extraction dirs per-server instead of process-global, avoiding
              // cross-suite collisions on a shared temp directory.
              extractDir: fs.mkdtempSync(path.join(uploadRoot, "mobile-farm-")),
              repo: deps.repo,
              runner: deps.runner,
              env: uploads.env,
              // Read at dispatch, not at submit: an operator who changes a
              // device's policy expects the next job to honour it, not every
              // job queued since the change. A device removed between claim
              // and dispatch falls back to the weakest policy.
              resetPolicy: deps.deviceRepo.get(deviceId)?.resetPolicy,
              // Without the edition's hooks an isolated job fails its device
              // step with a clear message rather than running unisolated.
              isolation: { mode: deps.repo.getJob(jobId)?.isolation ?? 'disabled', hooks: edition?.isolation },
              onChange: (id) => events.publish(id),
            })
          );
        } finally {
          await jobInputs.remove(jobId);
          traceCtxByJob.delete(jobId);
          // The job is terminal by now, so the device reads as free again.
          controlHub.refreshModes();
        }
      }),
      // The old queue.enqueue().catch() published to SSE when a job failed
      // before it could record anything itself; the scheduler marks the job
      // terminal, and this keeps a connected dashboard from waiting on a
      // change event that would otherwise never arrive.
      onJobStartFailed: (jobId) => {
        events.publish(jobId);
        // Must happen HERE, not in runJob's finally: when a job fails to
        // start, that finally runs while the job row is still 'running' -
        // the scheduler only marks it terminal afterwards, in the catch that
        // calls this. Refreshing from the finally alone leaves a live viewer
        // reading "a job is running" for a device that is idle, until some
        // later job happens to correct it.
        controlHub.refreshModes();
      },
    });
  app.scheduler = scheduler;
  maintenance.onChange(requested => { if (!requested) scheduler.dispatch?.(); });

  const controlHub = new ControlHub({
    isDeviceBusy: (deviceId) => deps.repo.runningDeviceIds().includes(deviceId),
    onEvent: (deviceId, detail) => deps.deviceRepo.recordEvent(deviceId, "control", detail),
    createSource: (deviceId, onFrame, onError) =>
      createFrameSource({ deviceId, intervalMs: controlFrameIntervalMs, capture: id => maintenance.run('operation', () => captureScreenshot(id)), onFrame, onError }),
    leases: controlLeases,
    startControlStream: trackControlStream(maintenance, deps.startControlStream ?? startScrcpyControlStream),
    hasWaitingJobFor: (deviceId) => {
      if (scheduler.waitingJobFor) return scheduler.waitingJobFor(deviceId);
      if (edition && !edition.policy.canUse(deviceId)) return undefined;
      const jobId = deps.repo.listQueuedJobs().find(job => job.requiredDeviceTags.length === 0 && job.isolation === 'disabled')?.id;
      if (!jobId) return undefined;
      // Read the cap the same way Scheduler.dispatch does (src/scheduler.ts):
      // at the cap, dispatch returns before it ever looks at device free-ness,
      // so no countdown must start here either - otherwise a saturated farm
      // evicts an admin for a job that still can't start once control ends.
      // Read the cap the same way Scheduler.dispatch does (src/scheduler.ts):
      // at the cap, dispatch returns before it ever looks at device free-ness,
      // so no countdown must start here either - otherwise a saturated farm
      // evicts an admin for a job that still can't start once control ends.
      const cap = deps.repo.getSchedulerSettings()?.maxConcurrentJobs ?? null;
      if (cap !== null && deps.repo.runningCount() >= cap) return undefined;
      const enrolled = deps.deviceRepo.listEnrolled().filter(d=>!edition || edition.policy.canUse(d.id));
      // A drained device cannot take the job anyway: holding it costs CI
      // nothing, which is what makes "disable, then control" the escape hatch
      // for longer work (D-5).
      if (!enrolled.some((d) => d.id === deviceId)) return undefined;
      const busy = new Set([...deps.repo.runningDeviceIds(), ...controlLeases.occupiedDeviceIds()]);
      const anotherFree = enrolled.some((d) => d.id !== deviceId && !busy.has(d.id));
      return anotherFree ? undefined : jobId;
    },
    // Read lazily: the scheduler is constructed after the hub.
    onControlReleased: () => app.scheduler.dispatch?.(),
  });

  const controlTick = setInterval(() => controlHub.tick(Date.now()), 1000);
  controlTick.unref();

  const stopMaintenanceDrain = maintenance.onChange(requested => { if (requested) controlHub.close(); });
  const upgrade = createControlUpgrade({ userRepo: deps.userRepo, deviceRepo: deps.deviceRepo, sessionSecret: deps.sessionSecret, hub: controlHub, policy:edition?.policy, maintenance });
  app.control = {
    handleUpgrade: upgrade.handleUpgrade,
    close: () => {
      stopMaintenanceDrain();
      clearInterval(controlTick);
      controlHub.close();
      return upgrade.close();
    },
  };

  const uploadStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadRoot),
    filename: (_req, file, cb) => {
      const suffix = file.fieldname === "apk" ? ".apk" : ".tar.gz";
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${suffix}`);
    },
  });

  /**
   * Built per request, not once at startup, because multer freezes
   * `limits.fileSize` when the instance is constructed. A hoisted instance
   * would pin the cap to whatever it was at boot, so an admin saving a new
   * limit would see no effect until the service restarted - which is exactly
   * the deploy this setting exists to avoid. The storage engine stays hoisted;
   * multer() itself just builds a closure.
   */
  const uploadFields: RequestHandler = (req, res, next) => {
    const fileSize = deps.repo.effectiveUploadLimit();
    // Omit fileSize entirely when unlimited rather than passing Infinity:
    // multer compares against it with busboy's own limit handling, and an
    // absent key is the documented way to mean "no limit".
    const limits: multer.Options["limits"] = { files: 2, parts: 20, fields: 10 };
    if (fileSize !== null) limits.fileSize = fileSize;

    multer({ storage: uploadStorage, limits }).fields([
      { name: "apk", maxCount: 1 },
      { name: "flowsArchive", maxCount: 1 },
    ])(req, res, next);
  };

  const describeBytes = (bytes: number): string => {
    const mb = bytes / (1024 * 1024);
    return Number.isInteger(mb) ? `${mb} MB` : `${mb.toFixed(1)} MB`;
  };

  /**
   * Without this, a multer rejection falls through to Express's default
   * handler and returns an HTML error page from a JSON API - to a CI script
   * parsing `.error` with jq. This is the app's only error handler, and it is
   * deliberately scoped to POST /run rather than mounted globally: a
   * catch-all would quietly swallow errors from every other route too.
   *
   * multer removes both completed and in-flight files on abort
   * (make-middleware.js: uploadedFiles.concat(pendingFiles.filter(f => f.path))),
   * so this handler does not repeat cleanup - but a test asserts the upload
   * directory really is empty afterwards, because an unverified dependency
   * behaviour is not a guarantee.
   */
  const uploadErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
    if (!(err instanceof multer.MulterError)) {
      if (!err) {
        next();
        return;
      }
      log.error("upload failed", { err: String(err) });
      res.status(500).json({ error: "upload failed" });
      return;
    }

    if (err.code === "LIMIT_FILE_SIZE") {
      const limit = deps.repo.effectiveUploadLimit();
      const field = err.field ?? "file";
      // Name the limit, not just the fact of it: an error saying only "too
      // large" sends the operator to the source to find the number.
      res.status(413).json({
        error:
          limit === null
            ? `${field} exceeds the upload limit`
            : `${field} exceeds the upload limit of ${describeBytes(limit)} - an admin can change it on the Admin page`,
      });
      return;
    }

    if (err.code === "LIMIT_UNEXPECTED_FILE") {
      res.status(400).json({ error: `unexpected file field "${err.field ?? "unknown"}"` });
      return;
    }

    res.status(400).json({ error: `upload rejected: ${err.code}` });
  };

  const artifactRoot = path.resolve(deps.dataDir, "artifacts");

  /** Same resolve-and-verify-inside check as api/files.ts's resolveInside.
   * Not exploitable today - nothing user-controlled reaches relPath, it is
   * only ever written by this service - but the two modules should not
   * disagree on a security-relevant pattern. */
  const resolveInside = (relPath: string): string | undefined => {
    const resolved = path.resolve(artifactRoot, relPath);
    return resolved.startsWith(artifactRoot + path.sep) ? resolved : undefined;
  };

  const readOutput = (step: StepRow): { stdout: string; stderr: string } => {
    const read = (kind: "stdout" | "stderr"): string => {
      const preview = kind === "stdout" ? step.stdoutPreview ?? "" : step.stderrPreview ?? "";
      const artifact = deps.repo.getArtifacts(step.id).find((a) => a.kind === kind);
      if (!artifact) return preview;
      const resolved = resolveInside(artifact.relPath);
      if (!resolved) return preview;
      try {
        return fs.readFileSync(resolved, "utf8");
      } catch {
        return preview;
      }
    };
    return { stdout: read("stdout"), stderr: read("stderr") };
  };

  app.post(
    "/run",
    auth,
    uploadFields,
    uploadErrorHandler,
    async (req: Request, res: Response) => {
      // Converting this handler to `async` (needed below, to await the app-id
      // resolution) changes what happens to a throw from ANY line in it, not
      // just the new code: Express 4 only catches a throw for you out of a
      // *synchronous* handler. Once a handler is async, a throw becomes a
      // rejected promise that this call returns to Express - which never
      // attaches a .catch to it - so it would otherwise be an unhandled
      // rejection (hung request, and Node terminates the whole process on an
      // unhandled rejection by default). Wrapping the body in try/catch
      // restores the old "always ends in a response" contract for every
      // pre-existing synchronous call in here too (e.g. deviceRepo.listEnrolled,
      // repo.createJob), not only the app-id resolution, which already has
      // its own narrower try/catch below.
      const files = req.files as UploadedFiles | undefined;
      // Once deps.repo.createJob succeeds below, ownership of the uploaded
      // files passes to runJob (jobRunner unlinks apkPath/flowsArchivePath
      // itself once it's done with them) - the catch-all below must not
      // delete them out from under an already-queued job if some later,
      // still-synchronous statement in this same try (e.g. res.status(202))
      // were to unexpectedly throw.
      let filesOwnedByJob = false;
      let preparedId: string | undefined;
      try {
        const apkFile = files?.apk?.[0];
        const flowsArchiveFile = files?.flowsArchive?.[0];

        if (!apkFile) {
          cleanupUploadedFiles(files);
          res.status(400).json({ error: "apk file is required" });
          return;
        }

        if (!flowsArchiveFile) {
          cleanupUploadedFiles(files);
          res.status(400).json({ error: "flowsArchive file is required" });
          return;
        }

        let flows: unknown;
        try {
          flows = typeof req.body?.flows === "string" ? JSON.parse(req.body.flows) : undefined;
        } catch {
          flows = undefined;
        }

        if (!Array.isArray(flows) || flows.length === 0 || flows.some((f) => typeof f !== "string")) {
          cleanupUploadedFiles(files);
          res.status(400).json({ error: "flows must be a non-empty JSON array of strings" });
          return;
        }

        let requiredDeviceTags: string[];
        try {
          const raw = req.body?.requiredDeviceTags;
          requiredDeviceTags = raw === undefined ? [] : parseDeviceTags(typeof raw === 'string' ? JSON.parse(raw) : null);
        } catch {
          cleanupUploadedFiles(files);
          res.status(400).json({ error: 'requiredDeviceTags must be a JSON array of at most 16 unique lowercase tags (1–32 letters, digits or hyphens, starting with a letter or digit)' });
          return;
        }
        if (requiredDeviceTags.length && !edition?.deviceRouting?.enabled()) {
          cleanupUploadedFiles(files);
          res.status(403).json({error: 'Device routing requires an active Pro license', code: 'PRO_ROUTING_REQUIRED'});
          return;
        }

        let isolation: IsolationMode;
        try {
          isolation = parseIsolation(req.body?.isolation);
        } catch (err) {
          cleanupUploadedFiles(files);
          res.status(400).json({ error: err instanceof Error ? err.message : 'invalid isolation' });
          return;
        }
        if (isolation !== 'disabled' && !edition?.isolation?.enabled()) {
          cleanupUploadedFiles(files);
          res.status(403).json({error: 'Work-profile isolation requires an active Pro license', code: 'PRO_ISOLATION_REQUIRED'});
          return;
        }

        let env: Record<string, string> | undefined;
        try {
          env = parseEnvField(req.body?.env);
        } catch (err) {
          // Same cleanup contract as every other 400 on this route: a rejected
          // request must not leave its uploads on disk.
          cleanupUploadedFiles(files);
          res.status(400).json({ error: err instanceof Error ? err.message : "invalid env" });
          return;
        }

        // Any enrolled device will do - the scheduler picks whichever is free
        // when the job reaches the front of the queue, which is why this only
        // checks that the pool is non-empty. A BUSY pool queues; that is the
        // entire point of the pool.
        if (deps.deviceRepo.listEnrolled().length === 0) {
          cleanupUploadedFiles(files);
          res.status(503).json({
            error: "no device is enrolled - add a device and enable it from the Devices page first",
          });
          return;
        }

        // The app id comes from the uploaded APK's own manifest, not a
        // separately configured value - there is nothing to keep in sync,
        // because it's read from the exact file about to be installed.
        // Resolved here, before the job is created or queued, so a corrupt or
        // unparseable APK never consumes the shared device's exclusive queue
        // slot for a job that was always going to fail.
        let appId: string;
        let appVersion: string | null;
        try {
          const appInfo = await (deps.resolveAppId ?? resolveAppIdFromApk)(apkFile.path);
          appId = appInfo.appId;
          appVersion = appInfo.appVersion;
        } catch (err) {
          cleanupUploadedFiles(files);
          res.status(400).json({
            error: err instanceof AppIdResolutionError ? err.message : "could not read an app id from the uploaded apk",
          });
          return;
        }

        preparedId = randomUUID();
        await jobInputs.save(preparedId, { appId, apkPath: apkFile.path, flowsArchivePath: flowsArchiveFile.path, env });
        // Entitlement may expire during APK parsing or durable input storage.
        if (requiredDeviceTags.length && !edition?.deviceRouting?.enabled()) {
          await jobInputs.remove(preparedId);
          cleanupUploadedFiles(files);
          res.status(403).json({error: 'Device routing requires an active Pro license', code: 'PRO_ROUTING_REQUIRED'});
          return;
        }
        if (isolation !== 'disabled' && !edition?.isolation?.enabled()) {
          await jobInputs.remove(preparedId);
          cleanupUploadedFiles(files);
          res.status(403).json({error: 'Work-profile isolation requires an active Pro license', code: 'PRO_ISOLATION_REQUIRED'});
          return;
        }
        const job = deps.repo.createJob(req.org as string, flows as string[], env, appId, appVersion, preparedId, requiredDeviceTags, isolation);
        recordJobSubmitted(req.org as string);
        filesOwnedByJob = true;

        // Everything this request resolved that the run will need, parked
        // where the scheduler's runJob closure can find it again. The device
        // is deliberately NOT decided here: binding a job to a device at
        // submit time would park it behind one device while another sat idle.
        cleanupUploadedFiles(files);
        // Captured here - synchronously, in this request's own async
        // context - so the job's span is a child of THIS "POST /run" span
        // regardless of which dispatch path later claims it.
        traceCtxByJob.set(job.id, context.active());

        // Nothing is awaited: submit only pokes the scheduler, which starts at
        // most as many jobs as there are free devices and defers each one.
        //
        // A dispatch failure must not fail a request whose job is already
        // persisted: the row is queued, the payload maps are populated, and
        // the safety tick will pick it up within seconds. Answering 500 here
        // would tell the caller the run never started while it goes on to run
        // - a divergence the old queue.enqueue().catch() could not produce.
        try {
          scheduler.submit(job.id);
        } catch (err) {
          log.error("initial dispatch failed; the safety tick will retry", {
            jobId: job.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }

        res.status(202).json({
          id: job.id,
          status: "queued",
          ...(isolation === 'per-flow' ? { warnings: [PER_FLOW_ISOLATION_WARNING] } : {}),
        });
      } catch (err) {
        // Catch-all for anything unexpected thrown synchronously anywhere
        // above (e.g. deviceRepo.listEnrolled or repo.createJob hitting a
        // transient SQLite error) - see the comment at the top of this
        // handler for why this is required once the handler is async.
        // Several paths above already send their own specific error response
        // before reaching here, so guard against double-responding.
        log.error("unhandled error in POST /run", {
          err: err instanceof Error ? err.message : String(err),
        });
        if (!filesOwnedByJob) {
          cleanupUploadedFiles(files);
          if (preparedId) await jobInputs.remove(preparedId).catch(() => log.error('failed to remove unqueued inputs'));
        }
        if (!res.headersSent) {
          res.status(500).json({ error: "internal error" });
        }
      }
    }
  );

  app.get("/run/:id", auth, (req, res) => {
    const job = deps.repo.getJob(req.params.id);
    if (!job || job.org !== req.org) {
      res.status(404).json({ error: "job not found" });
      return;
    }
    res.status(200).json(toLegacyJob(job, deps.repo.getSteps(job.id), readOutput));
  });

  app.get("/jobs", auth, (req, res) => {
    // This is the frozen CI response shape - DonableApp's pipeline depends on
    // it returning up to the historical 200-job cap. listJobs' own default is
    // 100 (tuned for the dashboard's /api/jobs); relying on that default here
    // would silently halve what this endpoint used to return. Pin 200
    // explicitly so the cap is a visible decision at this call site, not an
    // inherited default that drifts if listJobs' default ever changes.
    const jobs = deps.repo
      .listJobs(req.org as string, 200)
      .map((job) => toLegacyJob(job, deps.repo.getSteps(job.id), readOutput));
    res.status(200).json(jobs);
  });

  app.get("/status", auth, (req, res) => {
    // The response body now depends on which org's cookie/token was
    // presented, not just the URL - without these headers a shared or
    // browser cache could serve one org's status page to another.
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vary", "Cookie");
    const jobs = deps.repo
      .listJobs(req.org as string)
      .map((job) => toLegacyJob(job, deps.repo.getSteps(job.id), readOutput));
    res.status(200).type("html").send(renderStatusPage(jobs));
  });

  const publicDir = deps.publicDir ?? path.join(__dirname, "public");

  // The CLI installer, deliberately UNAUTHENTICATED and mounted here rather
  // than beside the auth-guarded routers at the bottom of this function, for
  // two independent reasons:
  //   1. You install the CLI before you have a credential. A 401 on the
  //      `curl ... | sh` line would be the first thing a new user hits.
  //   2. The catch-all 404 further down matches everything outside /api/*,
  //      so anything mounted after it never sees /cli/install.sh at all.
  // The script carries no secret: it resolves public packages from
  // registry.npmjs.org. __dirname resolution matches mcp.mjs and BUILD_INFO.
  app.use(cliRoutes({ installScriptPath: path.join(__dirname, "install.sh") }));

  // Explicit routes for /login, /devices, /admin and /orgs/:id must come BEFORE express.static:
  // Next's static export emits BOTH a flat login.html/devices.html file AND
  // a same-named directory (login/, devices/ - RSC-payload metadata, no
  // index.html inside). When a request path matches an existing directory,
  // express.static's directory-handling takes priority over its
  // extensions:['html'] fallback and 301-redirects to the trailing-slash
  // path - which then has no index file to serve and falls through,
  // unauthenticated, straight into the auth-guarded routers below, returning
  // a bare 401 instead of the login or devices page. Verified directly:
  // disabling the redirect (`redirect: false`) does not fix this - it just
  // turns the dead end into a 404, since serve-static's extensions retry
  // only triggers on a plain ENOENT, not on a directory-without-index.
  // Defining these routes before express.static bypasses the collision
  // entirely.
  app.get("/login", (_req, res) => {
    res.sendFile(path.join(publicDir, "login.html"));
  });
  for (const page of ["account", "notifications", "reset-password", "verify-email", "accept-invitation", "notification-run"]) {
    app.get(`/${page}`, (_req, res) => {
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Cache-Control", "no-store");
      res.sendFile(path.join(publicDir, `${page}.html`));
    });
  }
  app.get("/devices", (_req, res) => {
    res.sendFile(path.join(publicDir, "devices.html"));
  });
  app.get("/admin", (_req, res) => {
    res.sendFile(path.join(publicDir, "admin.html"));
  });
  app.get("/about", (_req, res) => {
    res.sendFile(path.join(publicDir, "about.html"));
  });
  app.get("/mcp-setup", (_req, res) => {
    res.sendFile(path.join(publicDir, "mcp-setup.html"));
  });
  // Bare "/cli" only. GET /cli/install.sh is served by cliRoutes above, which
  // is mounted earlier and therefore wins; everything else under /cli falls
  // through to the catch-all as before.
  app.get("/cli", (_req, res) => {
    res.sendFile(path.join(publicDir, "cli.html"));
  });
  // The job list itself - not bare "/jobs", which is the frozen CI-facing
  // JSON route above (DonableApp's pipeline depends on that exact response
  // shape). /jobs/<id> (job detail, further below) stays as it was.
  app.get("/history", (_req, res) => {
    res.sendFile(path.join(publicDir, "history.html"));
  });
  app.get(/^\/orgs\/.+/, (_req, res) => {
    res.sendFile(path.join(publicDir, "orgs.html"));
  });

  // Dashboard static serving. Mounted after the literal /run, /jobs and
  // /status routes above (so express.static's extensions:['html'] fallback
  // can never hijack the legacy, auth-scoped GET /jobs by matching
  // jobs.html for the bare "/jobs" path) but BEFORE the auth-guarded
  // app.use(auth, ...) mounts below. That ordering matters: app.use(auth,
  // router) applies `auth` unconditionally to every request that reaches
  // it (Express runs it before the router gets a chance to say "not mine"),
  // so placing the dashboard's public shell after those mounts would 401
  // every browser request for "/" before express.static ever ran. Mounting
  // it here keeps "/" and "/jobs/:id" public while still falling through to
  // the auth-guarded /api/* routes for anything express.static and the
  // /jobs/:id fallback below don't match.
  app.use(express.static(publicDir, { extensions: ["html"] }));

  // Static export produces exactly one file for the (non-dynamic) job
  // detail page, jobs.html - there is no per-job HTML file, since job IDs
  // are unknown at build time. Any GET under /jobs/ that the static
  // middleware above didn't already resolve (i.e. anything but the literal
  // /jobs path) gets that same shell; the page reads the id from
  // window.location client-side.
  app.get(/^\/jobs\/.+/, (_req, res) => {
    res.sendFile(path.join(publicDir, "jobs.html"));
  });

  // Catches any GET that reached this point unmatched (not a known page,
  // not a static asset, not /jobs/:id) - without this, an unknown path
  // like a typo'd URL falls through into the auth-guarded routers below
  // and returns a confusing 401 regardless of whether the visitor is
  // authenticated, instead of a plain 404. Scoped narrowly: this is NOT a
  // general SPA catch-all (the three explicit page routes above still do
  // their own thing) - it only handles the "nothing matched" case.
  //
  // Must exclude /api/*: a bare "*"/RegExp-all wildcard placed here (i.e.
  // before the app.use(auth, ...) mounts below) would also swallow every
  // /api/* request, turning an unauthenticated GET /api/jobs into this 404
  // instead of letting it reach the auth-guarded API routers and return
  // 401 as it should. Verified with a dedicated test (tests/server.test.ts).
  app.get(/^\/(?!api(\/|$)|openapi\.json$|api-docs$).*$/, (_req, res) => {
    res.status(404).sendFile(path.join(publicDir, "404.html"));
  });

  // Dashboard JSON API: mounted behind the same `auth` guard as /run and
  // /jobs above, so every route here is org-scoped the same way.
  app.use(auth, jobRoutes({ repo: deps.repo, events, dataDir: deps.dataDir,
    waitingReason: id => app.scheduler.jobWaitingReason ? app.scheduler.jobWaitingReason(id) :
      waitingReasonFallback(deps.repo.getJob(id)) }));
  if (edition?.deviceRouting) app.use(auth, edition.deviceRouting.routes);
  app.use(auth, maintenanceRoutes(maintenance));
  app.use(auth, fileRoutes({ repo: deps.repo, dataDir: deps.dataDir }));
  if (edition) app.use(auth, editionRoutes({policy:edition.policy,deviceRepo:deps.deviceRepo,dispatch:()=>app.scheduler.dispatch?.(),blockedReason:()=>app.scheduler.blockedReason?.() ?? null}));
  app.use(
    auth,
    deviceRoutes({
      maintenance,
      policy: edition?.policy,
      repo: deps.repo,
      deviceRepo: deps.deviceRepo,
      userRepo: deps.userRepo,
      runner: deps.runner,
      isolationEnabled: !!edition?.isolation,
      controlLeases,
      hasLiveViewers: (deviceId) => controlHub.viewerCount(deviceId) > 0,
    })
  );
  app.use(auth, orgRoutes({ orgRepo: deps.orgRepo, tokenRepo: deps.orgTokenRepo, userRepo: deps.userRepo }));
  app.use(auth, adminRoutes({ orgRepo: deps.orgRepo, userRepo: deps.userRepo, repo: deps.repo }));
  // __dirname is dist/ at runtime (src/ under ts-jest), which is where
  // `npm run build:mcp` / ci/package.sh's esbuild step write mcp.mjs - the
  // same module-relative resolution src/version.ts uses for BUILD_INFO,
  // and for the same reason: nothing sets a systemd WorkingDirectory.
  app.use(auth, mcpClientRoutes({ bundlePath: path.join(__dirname, "mcp.mjs") }));

  return app;
}
