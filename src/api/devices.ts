import type { MaintenanceCoordinator } from '../maintenance/coordinator';
import { Router, type Request, type Response, type NextFunction } from "express";
import { type CommandRunner, createRunner, getMaestroVersion } from "../maestro";
import { log } from "../telemetry/log";
import { captureDeviceScreenshot, type ScreenshotCapturer } from "../screenshot";
import { readVersion } from "../version";
import type { JobRepository } from "../store/jobRepository";
import type { DeviceRepository } from "../store/deviceRepository";
import type { ControlLeases } from "../control/leases";
import { isResetPolicy, RESET_POLICIES } from "../store/rows";
import type { UserRepository } from "../store/userRepository";
import type { DevicePolicy } from "../editions/policy";
import { buildProbeArgs, checkResult, findSetupCheck, parseProbeOutput, unknownSetupChecks } from "../deviceSetupChecks";

export type { ScreenshotCapturer };

/**
 * A separate, seconds-scale timeout for the ops "is the device alive" check.
 * `defaultRunner` from ../maestro uses DEFAULT_TIMEOUT_MS (15 minutes),
 * sized for a Maestro flow that must be allowed to run long - reusing it
 * here would let a wedged device hold this endpoint for a quarter of an
 * hour, exactly when an operator is trying to find out what is wrong.
 * DEFAULT_TIMEOUT_MS itself must not change: flows depend on it.
 */
const DEVICE_STATUS_TIMEOUT_MS = 5_000;

export const deviceOpsRunner: CommandRunner = createRunner(DEVICE_STATUS_TIMEOUT_MS);

const SETUP_INSTRUCTIONS: string[] = [
  "Connect the device to the farm host over USB.",
  "On the device, enable Developer Options and turn on USB debugging.",
  'Run "adb devices" on the farm host and accept the USB debugging prompt on the device screen.',
  'In Developer Options, turn ON "Disable adb authorization timeout" and turn OFF "Verify apps over USB" - otherwise the device forgets this host after 7 days and Play Protect can hang installs. The device card warns about both and an admin can fix them with one click.',
  'Confirm the serial "adb devices" prints matches the id you register here - that serial is this device\'s permanent identity.',
  'Once "adb devices" shows it as authorized, use "Enable" on its card to add it to the pool of devices jobs run on.',
];

/** `adb devices` output -> serial => state ("device", "unauthorized", ...). */
function parseAdbDevices(stdout: string): Map<string, string> {
  const stateById = new Map<string, string>();
  for (const line of stdout.split("\n").map((l) => l.trim())) {
    if (!line || line.startsWith("List of devices attached")) continue;
    const [id, state] = line.split(/\s+/);
    if (id) stateById.set(id, state ?? "unknown");
  }
  return stateById;
}

/**
 * Who to credit in the device event log.
 *
 * `req.org` alone was not enough: it is only set when an org resolves from an
 * `x-org-id` header or `orgId` query, and the dashboard's own fetches send
 * neither. Session-authenticated actions therefore recorded "by undefined" -
 * observed in production on `screenshot` and `reset_policy` events, which
 * defeats the point of having an audit trail at all.
 *
 * A username is the most useful answer, an org name is the right one for a
 * token/CI caller, and the user id is a last resort that is still an
 * identifier. "an unidentified caller" should be unreachable; it exists so
 * this can never render the word "undefined" again.
 */
function actorOf(req: Request, userRepo?: UserRepository): string {
  if (req.userId !== undefined) {
    const user = userRepo?.getById(req.userId);
    if (user) return user.username;
  }
  if (typeof req.org === "string" && req.org) return req.org;
  if (req.userId !== undefined) return `user #${req.userId}`;
  return "an unidentified caller";
}

export function deviceRoutes(deps: {
  policy?: DevicePolicy;
  /** Optional: only used to name who performed an action in the event log.
   * Without it the log falls back to the org, then the user id. */
  userRepo?: UserRepository;
  repo: JobRepository;
  deviceRepo: DeviceRepository;
  runner?: CommandRunner;
  captureScreenshot?: ScreenshotCapturer;
  /** Optional so every existing caller/test is unaffected; production always
   * passes the server's one ControlLeases instance so DELETE can refuse to
   * pull a device out from under a live control session. */
  controlLeases?: ControlLeases;
  /** Whether anyone currently has this device's live view open. Optional so
   * existing callers and tests are unaffected; absent means "nobody". */
  hasLiveViewers?: (deviceId: string) => boolean;
  maintenance?: MaintenanceCoordinator;
}): Router {
  const router = Router();
  // Bind checks to the handlers so Express path aliases cannot bypass policy.
  const hardware = (handler: (req: Request, res: Response) => unknown) => async (req: Request, res: Response, next: NextFunction) => {
    const releaseOperation = deps.maintenance?.acquire('operation');
    if (deps.maintenance && !releaseOperation) {
      res.status(503).json({ error: 'device access paused for maintenance', code: 'MAINTENANCE_MODE' }); return;
    }
    const release = deps.policy?.reserve?.(req.params.id);
    if (deps.policy && (deps.policy.reserve ? !release : !deps.policy.canUse(req.params.id))) {
      res.status(409).json({ error: 'Select this device in Community or use Pro', code: 'PRO_REQUIRED' });
      releaseOperation?.();
      return;
    }
    try { await handler(req, res); }
    catch (err) { next(err); }
    finally { release?.(); releaseOperation?.(); }
  };
  const runner = deps.runner ?? deviceOpsRunner;
  const captureScreenshot = deps.captureScreenshot ?? captureDeviceScreenshot;
  let maestroVersion: string | undefined;
  let versionCheckedAt = 0;
  let versionCheck: Promise<string> | undefined;
  const checkVersion = () => {
    if (!versionCheck) {
      versionCheck = getMaestroVersion(deps.runner).catch(() => "unknown").then(value => {
        maestroVersion = value;
        versionCheckedAt = Date.now();
        versionCheck = undefined;
        return value;
      });
    }
    return versionCheck;
  };

  // In-memory, scoped to this router instance (one per running server, fresh
  // per test app): only used to notice a transition between two polls, never
  // as the source of truth for current state, so losing it on restart just
  // means the first poll after boot logs nothing instead of a spurious
  // "unknown -> device".
  const lastKnownState = new Map<string, string>();

  // One `adb devices` call answers for every registered device at once, so
  // the list's cost stays flat as more devices are added instead of growing
  // one adb spawn per row.
  router.get("/api/devices", async (_req, res) => {
    const release = deps.maintenance?.acquire('operation');
    if (deps.maintenance && !release) {
      res.json({ devices: deps.deviceRepo.list().map(device => ({ ...device,
        state: lastKnownState.get(device.id) ?? 'unknown', setupChecks: unknownSetupChecks(),
        ...(deps.policy ? { isAvailable: deps.policy.canUse(device.id), edition: deps.policy.snapshot().edition } : {}),
      })), stale: true, maintenance: deps.maintenance.snapshot(), runnerVersion: readVersion(), artifactBytes: deps.repo.totalArtifactBytes() });
      return;
    }
    try {
      const known = deps.deviceRepo.list();
      const { stdout } = await runner("adb", ["devices"]);
      const liveStateById = parseAdbDevices(stdout);

      const devices = await Promise.all(
        known.map(async (device) => {
          const state = liveStateById.get(device.id) ?? "offline";

          let model = device.model;
          // Unknown until read: an offline/unauthorized device cannot be
          // asked, and "could not read" must never render as a warning.
          let setupChecks = unknownSetupChecks();
          if (state === "device") {
            try {
              // One shell call for the model AND every setup check - it
              // replaces the old bare getprop, so the poll's adb cost per
              // device is unchanged.
              const probe = await runner("adb", ["-s", device.id, "shell", ...buildProbeArgs()]);
              const parsed = parseProbeOutput(probe.stdout);
              setupChecks = parsed.checks;
              if (parsed.model && parsed.model !== device.model) {
                model = parsed.model;
                deps.deviceRepo.updateModel(device.id, parsed.model);
              }
            } catch {
              // Best-effort: a failed probe leaves the cached model and
              // unknown checks.
            }
          }

          const previousState = lastKnownState.get(device.id);
          if (previousState !== undefined && previousState !== state) {
            deps.deviceRepo.recordEvent(device.id, "state_change", `${previousState} -> ${state}`);
          }
          lastKnownState.set(device.id, state);

          return {
            id: device.id,
            label: device.label,
            tags: device.tags,
            model,
            isActive: device.isActive,
            ...(deps.policy ? { isAvailable: deps.policy.canUse(device.id), edition: deps.policy.snapshot().edition } : {}),
            state,
            resetPolicy: device.resetPolicy,
            setupChecks,
          };
        })
      );

      res.status(200).json({ devices, runnerVersion: readVersion(), artifactBytes: deps.repo.totalArtifactBytes() });
    } catch (err) {
      log.error("device list check failed", { err: String(err) });
      res.status(502).json({ error: "device status unavailable" });
    } finally { release?.(); }
  });

  router.post("/api/devices", (req, res) => {
    const { id, label } = (req.body ?? {}) as { id?: unknown; label?: unknown };
    if (typeof id !== "string" || !id.trim()) {
      res.status(400).json({ error: 'id is required - the device\'s adb serial, as shown by "adb devices"' });
      return;
    }
    const trimmedId = id.trim();
    if (deps.deviceRepo.get(trimmedId)) {
      res.status(409).json({ error: `device ${trimmedId} is already registered` });
      return;
    }

    const device = deps.deviceRepo.add(trimmedId, typeof label === "string" && label.trim() ? label.trim() : trimmedId);
    deps.deviceRepo.recordEvent(device.id, "added", `registered by ${actorOf(req, deps.userRepo)}`);
    res.status(201).json({ device, setupInstructions: SETUP_INSTRUCTIONS });
  });

  const setEnrolment = (enrolled: boolean) => (req: Request, res: Response) => {
    const device = deps.deviceRepo.get(req.params.id);
    if (!device) {
      res.status(404).json({ error: "unknown device" });
      return;
    }
    if (enrolled && deps.policy && !deps.policy.canUse(device.id)) {
      res.status(409).json({ error: 'Select this device in Community or use Pro', code: 'PRO_REQUIRED' });
      return;
    }
    if (device.isActive === enrolled) {
      res.status(200).json({ device });
      return;
    }

    // Note what is NOT here: no hasActiveJob guard on either direction.
    // Enabling adds a free device to the pool, which disrupts nothing.
    // Disabling is a drain - the device finishes the job it holds and is
    // simply never claimed again. Neither ever interrupts a running flow,
    // which is why switching devices no longer needs to wait for the farm to
    // go idle the way activate() did.
    // This reasoning covers RUNNING flows only. It says nothing about jobs
    // still 'queued': those are simply left for another enrolled device to
    // claim - or, if this was the last one, stranded with no device able to
    // claim them, no timeout, and no terminal status. See "Enable, disable,
    // remove" in docs/guide/operating.md.
    if (enrolled) deps.deviceRepo.enable(device.id);
    else deps.deviceRepo.disable(device.id);

    deps.deviceRepo.recordEvent(
      device.id,
      enrolled ? "enabled" : "disabled",
      `${enrolled ? "enabled" : "disabled"} by ${actorOf(req, deps.userRepo)}`
    );
    res.status(200).json({ device: deps.deviceRepo.get(device.id) });
  };

  router.post("/api/devices/:id/enable", setEnrolment(true));
  router.post("/api/devices/:id/disable", setEnrolment(false));
  // Deprecated alias: the dashboard is a separately-built static bundle, so an
  // operator can have a tab open from before this deploy. Remove once a
  // release has been out long enough that no such tab plausibly survives.
  router.post("/api/devices/:id/activate", setEnrolment(true));

  /** Long enough for "Galaxy S10 (farm, desk by the window)", short enough
   * that a device list stays readable. */
  const MAX_LABEL_LENGTH = 100;

  /**
   * Renames a device. The id is the adb serial and is never editable - only
   * the display name is.
   *
   * Deliberately separate from the reset policy endpoint: that one is
   * admin-only and writes an audit event about data deletion. Folding the two
   * together would mean re-deciding both, and would let a later field inherit
   * or weaken that gate by accident.
   */
  router.patch("/api/devices/:id", (req, res) => {
    const device = deps.deviceRepo.get(req.params.id);
    if (!device) {
      res.status(404).json({ error: "unknown device" });
      return;
    }

    const raw = (req.body as { label?: unknown } | undefined)?.label;
    if (typeof raw !== "string") {
      res.status(400).json({ error: "label must be a string" });
      return;
    }
    const label = raw.trim();
    // Enrolment falls back to the device id when no label is given, because
    // there is nothing better to use. Clearing the field on an EDIT is a
    // mistake worth reporting rather than silently renaming the phone to its
    // serial number.
    if (!label) {
      res.status(400).json({ error: "label must not be empty" });
      return;
    }
    if (label.length > MAX_LABEL_LENGTH) {
      res.status(400).json({ error: `label must be at most ${MAX_LABEL_LENGTH} characters` });
      return;
    }

    if (label === device.label) {
      res.status(200).json({ device });
      return;
    }

    deps.deviceRepo.setLabel(device.id, label);
    deps.deviceRepo.recordEvent(
      device.id,
      "renamed",
      `renamed from "${device.label}" to "${label}" by ${actorOf(req, deps.userRepo)}`
    );
    res.status(200).json({ device: deps.deviceRepo.get(device.id) });
  });

  /**
   * Reset policy is set here and nowhere else - never on a job. Flows must run
   * byte-identical against DeviceCloud and DeviceYard, so how hard a handset
   * scrubs itself is the device's business, not the caller's.
   *
   * Moving to a stronger policy deletes browsing data on the next job, so the
   * change is written to the device event log with whoever made it.
   */
  router.post("/api/devices/:id/reset-policy", hardware((req, res) => {
    // Admin-only, matching adminRoutes: a CI bearer token never sets
    // req.isAdmin, so an automated caller cannot flip a device into deleting
    // browsing data.
    if (!req.isAdmin) {
      res.status(403).json({ error: "admin access required" });
      return;
    }
    const device = deps.deviceRepo.get(req.params.id);
    if (!device) {
      res.status(404).json({ error: "unknown device" });
      return;
    }

    const requested = (req.body as { resetPolicy?: unknown } | undefined)?.resetPolicy;
    if (!isResetPolicy(requested)) {
      res.status(400).json({ error: `resetPolicy must be one of: ${RESET_POLICIES.join(", ")}` });
      return;
    }

    if (requested === device.resetPolicy) {
      res.status(200).json({ device });
      return;
    }

    deps.deviceRepo.setResetPolicy(device.id, requested);
    deps.deviceRepo.recordEvent(
      device.id,
      "reset_policy",
      `reset policy changed from ${device.resetPolicy} to ${requested} by ${actorOf(req, deps.userRepo)}`
    );
    res.status(200).json({ device: deps.deviceRepo.get(device.id) });
  }));

  router.delete("/api/devices/:id", (req, res) => {
    const device = deps.deviceRepo.get(req.params.id);
    if (!device) {
      res.status(404).json({ error: "unknown device" });
      return;
    }
    if (device.isActive) {
      res.status(409).json({ error: "device is still enrolled - disable it first" });
      return;
    }
    if (deps.repo.hasActiveJob(device.id)) {
      res.status(409).json({ error: "a job is still running on this device - wait for it to finish" });
      return;
    }
    // Two distinct states, both worth refusing. Control is the stronger one,
    // so it is reported first: an admin driving the phone gets a different
    // instruction from someone merely watching it.
    if (deps.controlLeases?.get(device.id)) {
      res.status(409).json({ error: "an admin is currently in control of this device - end the session first" });
      return;
    }
    // Removing a device out from under an open live view is never what the
    // admin meant, and it used to crash the service when that viewer later
    // disconnected (see ControlHub.emitEvent). The hub now survives it
    // regardless; this makes the intent explicit and keeps the audit trail.
    if (deps.hasLiveViewers?.(device.id)) {
      res.status(409).json({ error: "this device is being watched in live view - close the screen first" });
      return;
    }

    // No device_events row: those cascade-delete with the device (see
    // remove()'s own doc comment), so recording the removal there would
    // delete itself in the same statement, leaving no trace either way.
    // A structured log line is the only place this action can survive.
    log.info("device removed", { deviceId: device.id, label: device.label, actor: actorOf(req, deps.userRepo) });
    deps.deviceRepo.remove(device.id);
    res.status(204).end();
  });

  router.get("/api/devices/:id/events", (req, res) => {
    const device = deps.deviceRepo.get(req.params.id);
    if (!device) {
      res.status(404).json({ error: "unknown device" });
      return;
    }
    const limit = Math.max(1, Math.min(Number(req.query.limit ?? 30) || 30, 100));
    res.status(200).json({ events: deps.deviceRepo.listEvents(device.id, limit) });
  });

  router.post("/api/devices/:id/reboot", hardware(async (req, res) => {
    const device = deps.deviceRepo.get(req.params.id);
    if (!device) {
      res.status(404).json({ error: "unknown device" });
      return;
    }
    // Per-device, not farm-wide: with a pool, a job on device A must never
    // block a reboot of device B.
    if (deps.repo.hasActiveJob(device.id)) {
      res.status(409).json({ error: "a job is currently running on this device - wait for it to finish before rebooting" });
      return;
    }

    try {
      const { code, stderr } = await runner("adb", ["-s", device.id, "reboot"]);
      if (code !== 0) {
        res.status(502).json({ error: `adb reboot failed: ${stderr.trim() || `exit ${code}`}` });
        return;
      }
      deps.deviceRepo.recordEvent(device.id, "reboot", `requested by ${actorOf(req, deps.userRepo)}`);
      res.status(202).json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: `could not reboot device: ${err instanceof Error ? err.message : String(err)}` });
    }
  }));

  /**
   * Apply one setup check's fix (spec D-1: the only way DeviceYard changes a
   * device setting). Success means the value READ BACK as fixed - a write
   * that silently did nothing (a vendor ROM, Play services resetting it)
   * must not clear the warning.
   *
   * Allowed while a job runs: one settings write does not disturb a flow,
   * and refusing would make it unusable on a busy device.
   */
  router.post("/api/devices/:id/setup-checks/:checkId/fix", hardware(async (req, res) => {
    // Admin-only, like reset-policy: a CI token never sets req.isAdmin.
    if (!req.isAdmin) {
      res.status(403).json({ error: "admin access required" });
      return;
    }
    const device = deps.deviceRepo.get(req.params.id);
    if (!device) {
      res.status(404).json({ error: "unknown device" });
      return;
    }
    const check = findSetupCheck(req.params.checkId);
    if (!check) {
      res.status(404).json({ error: "unknown setup check" });
      return;
    }

    const { stdout } = await runner("adb", ["devices"]);
    if (parseAdbDevices(stdout).get(device.id) !== "device") {
      res.status(409).json({ error: "device is not connected and authorized" });
      return;
    }

    const write = await runner("adb", ["-s", device.id, "shell", ...check.fixArgs]);
    if (write.code !== 0) {
      res.status(502).json({ error: `could not apply the setting: ${write.stderr.trim() || `exit ${write.code}`}` });
      return;
    }

    const readBack = await runner("adb", ["-s", device.id, "shell", ...check.readArgs]);
    const value = readBack.stdout.trim();
    if (readBack.code !== 0 || !check.isOk(value)) {
      res.status(502).json({ error: `setting did not take effect (read back: ${value || "nothing"})` });
      return;
    }

    deps.deviceRepo.recordEvent(device.id, "setup_fix", `"${check.title}" fixed by ${actorOf(req, deps.userRepo)}`);
    res.status(200).json({ check: checkResult(check, true) });
  }));

  router.get("/api/devices/:id/screenshot", hardware(async (req, res) => {
    const device = deps.deviceRepo.get(req.params.id);
    if (!device) {
      res.status(404).json({ error: "unknown device" });
      return;
    }

    try {
      const png = await captureScreenshot(device.id);
      deps.deviceRepo.recordEvent(device.id, "screenshot", `requested by ${actorOf(req, deps.userRepo)}`);
      res.status(200).type("image/png").send(png);
    } catch (err) {
      res.status(502).json({ error: `could not capture screenshot: ${err instanceof Error ? err.message : String(err)}` });
    }
  }));

  // Not device-scoped, but this router is already mounted with `auth` and
  // already imports readVersion for GET /api/devices' runnerVersion field -
  // a dedicated router for one trivial read-only route (the About screen)
  // would be more machinery than the route itself.
  router.get("/api/version", async (req, res) => {
    // deps.runner, not the local `runner` var above - that one falls back to
    // deviceOpsRunner's 5s timeout (sized for near-instant adb status
    // checks), too short for maestro --version's real JVM startup cost. Pass
    // deps.runner through as-is: undefined in production, so
    // getMaestroVersion falls through to its own better-suited default,
    // while tests can still inject a fake via deps.runner as before.
    const stale = maestroVersion === undefined || Date.now() - versionCheckedAt > 5 * 60_000;
    if (req.query.waitForMaestro === "false") {
      if (stale) void checkVersion();
      res.status(200).json({ version: readVersion(), maestroVersion: maestroVersion ?? "unknown", maestroPending: !!versionCheck });
      return;
    }
    res.status(200).json({ version: readVersion(), maestroVersion: stale ? await checkVersion() : maestroVersion });
  });

  return router;
}
