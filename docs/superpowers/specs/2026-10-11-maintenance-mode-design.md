# Maintenance mode

## Purpose

Allow an administrator to reserve a maintenance window even when jobs arrive continuously. Stop starting work, finish existing jobs normally, and preserve queued jobs for an explicit resume. This is an operational feature in both Community and Pro; it does not change edition limits or device enrollment.

## User experience

An administrator selects **Enable maintenance** in the dashboard. The instance moves from **Normal** to **Draining**, displaying running jobs and outstanding device operations. New submissions still enter the queue, with maintenance visible as their waiting reason. Once jobs and device operations have finished, show **Ready for maintenance**. An administrator selects **Resume** to start scheduling again under existing eligibility and ordering rules.

Do not suspend active Maestro processes: their devices, backend services, and timeouts continue advancing independently. Do not cancel jobs automatically or force readiness after a deadline. A stuck job or operation remains visible; existing cancellation controls remain available. Resume is allowed during draining and cancels the maintenance request without interrupting jobs.

Maintenance survives application restarts and has no automatic expiry. External CI/client deadlines still apply; the UI and operating guide must explain that queued work is preserved but callers can time out.

## State and concurrency

Persist a singleton maintenance-request flag in SQLite, defaulting to off for existing installations. Derive the displayed state from that flag and live activity; never persist a stale claim of readiness. Load the flag before starting schedulers, probes, or streams. Startup recovery retains existing handling of interrupted running jobs and preserves queued jobs.

Guard job claiming atomically in `JobRepository.claimNextQueued`, using the persisted flag in the same database operation that claims a job. Scheduler early checks provide clear status, but are not the correctness boundary. A claim committed before maintenance is an existing job and drains normally; a claim after maintenance commits must fail. Both the Community scheduler and Pro pool scheduler use this boundary.

Add one instance-level device-access coordinator. Before starting non-job device access, callers synchronously acquire an activity lease only while maintenance is off; release it only after underlying processes/connections have ended. Existing running jobs retain permission for their full lifecycle, including cleanup, artifacts, and device reset. Their completion must not be reported before those operations finish. Internal job permission must not be obtainable by an API caller.

The initial implementation supports the existing single server process per instance. It must not imply coordination between separately running DeviceYard installations or arbitrary host ADB clients.

## Device access during maintenance

Block new remote-control sessions, device mutations, setup/fix actions, and background device discovery or health probes. Cover subprocess-based ADB and scrcpy's direct ADB connections. Close existing interactive control/viewer streams when maintenance is requested, and count their teardown until complete. Let finite operations already in progress finish; expose their count while draining. Read-only pages return stored information with a stale/maintenance indication instead of probing devices. Suppress maintenance-caused device-offline alerts without suppressing unrelated server failures.

Audit all device-access entry points during implementation, including jobs, device APIs, notifications, startup tasks, and streaming. Readiness requires zero running job lifecycles, zero non-job device operations, and no live control/viewer connections. Any untracked access path is a release blocker for this feature.

**Ready for maintenance means DeviceYard has stopped issuing device operations.** It does not mean USB is physically released: the host ADB daemon or another process may still hold devices. The container handover runbook must separately stop the legacy runner/host ADB as appropriate after readiness and verify ownership. The toggle must not kill a shared host ADB daemon automatically.

## API, authorization, and observability

Provide an authenticated status endpoint and an administrator-only idempotent setter for the requested maintenance state. Return requested state, derived state, running-job count, outstanding device-operation count, and active-stream count. Mutating device endpoints blocked by maintenance return a consistent temporary-unavailability response with a machine-readable maintenance code. Job submission remains successful, and cancellation remains available under existing authorization.

Use the dashboard's existing authorization and request protections. Log who enabled/resumed maintenance and each state transition using structured events, without credentials or job payloads. Keep maintenance status separate from edition/license blocking reasons so both can be displayed correctly.

## Repository and rollout scope

Implement the shared behavior in DeviceYard Community and update DeviceYard-Pro's pinned core plus scheduler integration tests. The live farm still runs the legacy MobileDeviceFarm deployment: it does not receive a Community change automatically. Port the required behavior into that deployment through a separate reviewed change, accounting for its additional device-setup endpoints. Avoid editing the active device-setup checkout or changing its branch.

Feature implementation and CI do not authorize a production deployment or USB handover. Coordinate deployment and the physical-device acceptance window separately. Keep existing publication, image release, and attribution gates independent of this feature.

## Acceptance checks

- Enabling maintenance races safely with job claims: each job either started before the flag committed and drains, or remains queued.
- Repeated submissions and completion-triggered dispatch cannot start queued work while maintenance is requested, in either edition and in the legacy scheduler.
- Running work completes normally, including cleanup; waiting jobs are retained across restart and resume once under existing scheduling rules.
- Restart while maintenance is requested starts no probes, device work, or streams before applying the persisted state.
- Remote streams close, finite operations drain, new device access is denied, and readiness never appears while tracked activity remains.
- Resume during draining and repeated enable/resume requests are safe; device enrollment and edition restrictions remain unchanged.
- Unauthorized changes are rejected; status and maintenance waiting reasons render in the dashboard; intentional probe suppression produces no device-offline alert.
- A coordinated real-device check verifies the legacy runner drains and the explicit host-ADB handover procedure works before container acceptance.
