# Maintenance Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Drain device activity without interrupting running jobs, preserve queued work across restarts, and resume explicitly.

**Architecture:** SQLite persists maintenance intent and guards atomic job claims. An instance-level coordinator tracks complete job lifecycles and non-job device activity. Durable queued inputs make the pause safe across native and container upgrades.

**Tech Stack:** Existing TypeScript, SQLite, Express, Next.js, Jest; no new runtime dependencies.

**Spec:** [Maintenance design](../specs/2026-10-11-maintenance-mode-design.md).

**Execution:** In-session implementation, followed by an independent whole-branch review. Start with Community, then integrate the pinned core into Pro and port to an isolated legacy worktree. Production deployment requires a separate go-ahead.

## Global constraints

- Maintenance is available in both editions and both deployment methods; retain all edition limits and enrollment settings.
- No forced cancellation, automatic resume, shared ADB daemon termination, or physical-device access during automated tests.
- Persist maintenance before acknowledging enable; derive readiness from actual outstanding activity.
- Running jobs retain device access through cleanup; new work cannot bypass maintenance through alternate APIs.
- Preserve queued inputs and secrets under the existing protected data directory; never log their content or expose their paths through public APIs.
- Native/systemd stays the production deployment. Docker remains experimental pending hardware acceptance.

## Review focus

- A job row survives restart but its uploads do not: task 1 must prove actual execution after reopening, not merely row persistence.
- Maintenance races an asynchronous online probe: task 2 must prove that probe completion cannot claim another job.
- A stream starts after a timeout or teardown: task 3 must count late startup/cleanup until its underlying connection closes.
- A job becomes terminal before cleanup completes: task 2 must keep readiness false until the lifecycle promise settles.
- Maintenance is resumed while an earlier drain is closing streams: task 3 must ensure stale callbacks neither reopen access during a later pause nor close newly created sessions.

## Task 1: Persist executable queued work

**Files:** create `src/store/jobInputs.ts`, `tests/store/jobInputs.test.ts`, `tests/serverQueueRecovery.test.ts`; modify `src/server.ts`, `src/jobRunner.ts`, `src/index.ts`, and `tests/serverRunHandlerCrashSafety.test.ts` as required by existing cleanup ownership.

**Interfaces:** `JobInputsStore(dataDir: string)` exposes `save(jobId, inputs): Promise<void>`, `load(jobId): Promise<QueuedJobInputs | undefined>`, and `remove(jobId): Promise<void>`. `QueuedJobInputs` contains `appId: string`, `apkPath: string`, `flowsArchivePath: string`, and optional `env: Record<string,string>`. Store-generated paths are derived from a validated job ID, never accepted from a persisted manifest.

- [ ] Add failing tests that submit APK/flows with environment values, recreate the server against the same data directory, and execute the original queued job using identical inputs. Assert secrets never enter error responses. Missing/corrupt input fails only the affected job with a safe diagnostic.
- [ ] Run `npm test -- --runInBand --watchman=false tests/store/jobInputs.test.ts tests/serverQueueRecovery.test.ts` and confirm expected failures.
- [ ] Stage uploads in a private per-job directory under `DATA_DIR`, write the manifest atomically, and complete this before queue insertion/dispatch. Replace the three in-memory execution-input maps with the store; retain optional trace context in memory. Handle failed submission, cancellation, completion, interrupted running jobs, and orphan staging directories without deleting inputs for queued/running jobs. Reuse persisted job app/environment fields where appropriate; avoid two competing sources of truth.
- [ ] Test crash boundaries before manifest publication, before job insertion, and after insertion. Reopening must retain executable queued work, remove only safe orphans, and preserve existing interrupted-running-job recovery behavior.
- [ ] Run the focused tests plus `tests/serverRunHandlerCrashSafety.test.ts`, `tests/jobRunner.test.ts`, and `tests/jobRunnerEnv.test.ts`; commit `feat: preserve queued job inputs across restart`.

## Task 2: Persist maintenance and guard scheduling

**Files:** create `src/maintenance/coordinator.ts`, `tests/maintenance/coordinator.test.ts`; modify `src/db/migrations.ts`, `src/store/jobRepository.ts`, `src/editions/scheduler.ts`, `src/editions/singleDeviceScheduler.ts`, `src/scheduler.ts`, `src/server.ts`; extend `tests/store/jobRepository.test.ts`, `tests/editions/community.test.ts`, `tests/serverDispatch.test.ts`.

**Interfaces:** repository exposes `isMaintenanceRequested(): boolean` and `setMaintenanceRequested(requested: boolean): void`. Coordinator exposes `setRequested(requested: boolean): void`, `snapshot(): MaintenanceStatus`, `acquire(kind: 'operation' | 'stream'): (() => void) | undefined`, and `trackClaimedJob<T>(jobId: string, run: () => Promise<T>): Promise<T>`. `MaintenanceStatus` is `{ requested: boolean; state: 'normal' | 'draining' | 'ready'; runningJobs: number; activeOperations: number; activeStreams: number }`. Job tracking is internal server wiring only. Readiness counts the union of tracked lifecycle job IDs and committed running job IDs, including terminal jobs whose cleanup is unfinished.

- [ ] Add failing tests for enable-before-claim, claim-before-enable, probe completion after enable, repeated requests, resume during drain, startup with maintenance already on, and terminal-row-before-cleanup completion.
- [ ] Run focused repository/coordinator/scheduler tests and confirm expected failures.
- [ ] Add a singleton migration defaulting off and an SQL maintenance predicate inside `claimNextQueued`. Apply early maintenance checks before scheduler probes, retaining the SQL guard as the final authority. Track the entire server job lifecycle including cleanup. Release activity leases idempotently, and recompute/log derived state transitions without polling-dependent correctness.
- [ ] Load maintenance before all device-capable startup work. Resume dispatches immediately but preserves scheduler stop state, eligibility, ordering, and edition policy. Maintenance is a separate status from license blocking.
- [ ] Run the focused tests; commit `feat: persist maintenance and drain job scheduling`.

## Task 3: Drain every device-access path

**Files:** modify `src/server.ts`, `src/index.ts`, `src/api/devices.ts`, `src/api/control.ts`, `src/control/hub.ts`, `src/control/frames.ts`, `src/control/controlStream.ts`, `src/notifications/health.ts`; extend their matching tests and add `tests/maintenance/deviceAccess.test.ts`.

**Interfaces:** add `ControlHub.drain(): Promise<void>` that closes current viewers/sources/streams, includes pending startups and teardown, and leaves the hub reusable after resume. Route-level device operations acquire coordinator leases before any asynchronous work. Wrap all non-job command, screenshot, and direct scrcpy access; job lifecycle operations use their already admitted job scope.

- [ ] Inventory actual device access with `rg -n 'adb|execFile|spawn|startScrcpy|captureScreenshot' src`; record each entry point and its protection in the maintenance operating guide. Include health probes and online checks; do not assume all access uses CommandRunner.
- [ ] Add failing tests: finite commands drain; new mutations return HTTP 503 with `code: 'MAINTENANCE_MODE'`; blocked WebSocket upgrades create no stream; late stream startup closes before readiness; in-flight screenshot completion remains counted; repeated pause/resume cannot reopen stale streams.
- [ ] Run focused control/device/health tests and confirm expected failures.
- [ ] Implement tracked draining, including asynchronous close acknowledgement rather than assuming `stop()` means process exit. Do not hide teardown failures by declaring readiness. Suppress new probes during maintenance; GET devices returns stored/cached data with `stale: true` and maintenance status. Unobserved devices must not be synthesized as offline.
- [ ] Test that suppressed health probes produce no maintenance-caused offline events while unrelated notification behavior remains intact. Verify active job reset/artifact cleanup continues and pending operations release on exceptions.
- [ ] Run the focused tests; commit `feat: drain device operations and remote sessions`.

## Task 4: Expose status and admin controls

**Files:** create `src/api/maintenance.ts`, `tests/api/maintenance.test.ts`, `dashboard/src/components/MaintenanceCard.tsx`, `dashboard/tests/components/MaintenanceCard.test.tsx`; modify `src/server.ts`, `src/openapi/document.ts`, `dashboard/src/lib/api.ts`, `dashboard/src/app/admin/page.tsx`, `dashboard/src/app/jobs/page.tsx`, `dashboard/src/app/devices/page.tsx`; add `docs/guide/maintenance.md` and update `docs/guide/operating.md`.

**Interfaces:** authenticated `GET /api/maintenance` returns `MaintenanceStatus`; admin-only `PUT /api/admin/maintenance` accepts exactly a boolean `requested` and returns the updated snapshot. Dashboard helpers `fetchMaintenance(): Promise<MaintenanceStatus>` and `setMaintenance(requested: boolean): Promise<MaintenanceStatus>` use existing auth/error handling.

- [ ] Add failing API tests for unauthenticated access, non-admin mutation, malformed bodies, idempotency, and successful submission/cancellation during maintenance. Add UI tests for Normal → Draining → Ready, counts, stale device data, errors, and resume during draining.
- [ ] Run API and dashboard focused tests and confirm expected failures.
- [ ] Add admin card under Execution & storage with **Enable maintenance** and **Resume** actions. Poll status without overlapping requests; display maintenance waiting information on job/device pages independently of edition blockers. Explain that active jobs finish and external CI deadlines still apply. Use existing request protections and log actor IDs/state changes without sensitive payloads.
- [ ] Document native and container behavior, readiness limits, restart preservation, and deployment as a separate operator action. Link the guide for later website publication; do not implement a second website content copy here.
- [ ] Run API/OpenAPI and dashboard tests; commit `feat: add maintenance controls and operating guide`.

## Task 5: Integrate both editions and native production source

**Files:** Pro repository `src/poolScheduler.ts`, scheduler tests, and pinned `core` submodule; legacy repository equivalents of tasks 1–4 including its additional device-setup endpoints.

- [ ] Inspect current main and repo instructions in both repositories before creating isolated feature worktrees; preserve other sessions' branches and uncommitted work.
- [ ] Add failing Pro tests for multiple jobs draining, queued jobs staying queued, restart persistence, and license expiry/resume interaction. Update Pro to the reviewed Community core commit and add early pool-scheduler maintenance checks; keep core atomic claim protection.
- [ ] Port the required native changes with migration numbers appropriate to legacy main. Inventory additional setup/fix endpoints and prove they are gated. Do not copy Community edition restrictions into the existing multi-device legacy deployment.
- [ ] Run each repository's required tests/builds and commit the integrations separately. No production restart, Docker installation, or physical-device test is part of this task.

## Task 6: Verify and hand over

- [ ] Run Community CI-equivalent checks: `npm test -- --runInBand --watchman=false --testTimeout=30000`, `npm --prefix dashboard test -- --runInBand --watchman=false`, `npm run build -- --webpack`, and `node ci/smoke.cjs`. Extend container smoke with paused queued-work persistence using fake job execution where suitable; real USB acceptance remains separate.
- [ ] Run container build/lifecycle checks for the changed packaged runtime, and required Pro/legacy checks. Review diffs for secret-bearing persistence permissions, startup ordering, durable file ownership, and untracked device activity.
- [ ] Obtain an independent whole-branch review; fix material findings and rerun affected checks.
- [ ] Open PRs in the owned repositories, respecting core dependency order. Monitor every required validation to finished green on the current heads; check Azure policy expiry where applicable. Hand over direct URLs and the names of verified runs.
- [ ] Prepare the native rollout procedure: drain, verify readiness, back up database and queued inputs together, deploy, verify maintenance persisted, then explicitly resume. Preserve a rollback backup and check schema compatibility before reverting binaries. Ask for deployment approval only when this procedure and artifacts are concrete.
