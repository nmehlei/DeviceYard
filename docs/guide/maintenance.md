# Maintenance mode

Use **Farm administration → Execution & storage → Maintenance mode** to pause
new device work without interrupting jobs already running. Maintenance works
with native/systemd and Docker deployments and is available in both editions.

1. Select **Enable maintenance**. The instance stops claiming queued jobs and
   closes remote-control/viewer connections. New submissions still queue.
2. Wait for **Ready for maintenance**. **Draining** shows jobs, finite device
   operations, and streams that have not finished. A stuck operation does not
   time out into a false ready state; investigate it before restarting.
3. Perform the planned maintenance. For an upgrade, stop the service after
   draining and back up the entire persistent data directory before replacing
   the application. Never run two instances against the same data directory.
4. Start the updated service and verify it remains in maintenance. Select
   **Resume** when ready to run queued jobs. You can also resume while draining
   to cancel the maintenance window without cancelling existing jobs.

Maintenance has no expiry and survives restarts. Device pages display cached
information during the pause. External CI/client deadlines keep advancing:
preserving a queued job cannot prevent its caller from timing out. Active jobs
are allowed to finish, not suspended midway through Android or Maestro work.

## Queue persistence and backups

Accepted jobs keep their APK, flow archive, app ID and execution environment in
`DATA_DIR/job-inputs`. Directories are private to the service account (0700),
and payload/manifest files use 0600. These include unmasked execution values:
protect backups as secrets and never publish this directory as static content.
The job API still returns masked environment values. Inputs are removed after
execution; startup removes abandoned staging and terminal-job inputs.

Back up the database and queued inputs together while the service is stopped.
For rollback, use the matching pre-upgrade backup if schema compatibility has
not been verified. Jobs submitted to older versions with transient uploads
cannot be recovered retroactively. A forced restart still fails running jobs;
wait for readiness first. Maintenance does not change enrollment or edition
limits, and does not add a job cancellation feature.

## What readiness guarantees

Ready means this DeviceYard instance has no outstanding tracked device work.
It does not stop a host ADB daemon or other applications. The toggle never
kills shared host services. A separate hardware handover, if needed, is an
operator action; routine maintenance does not require changing USB ownership.

If a scrcpy startup fails after launching a process and its exit cannot be
confirmed, maintenance stays **Draining**. Inspect and stop the orphaned scrcpy
process on the affected device before restarting DeviceYard. Restarting the
service alone clears its in-memory tracking but does not prove device cleanup.

Device-access coverage:

| Entry point | Maintenance behavior |
| --- | --- |
| Scheduler online check | Gated and tracked before invoking ADB |
| Atomic queued-job claim | Persisted SQLite maintenance guard |
| Running job: preparation, install, Maestro, recording, screenshots, cleanup | Allowed to finish; complete lifecycle counted |
| Device list/discovery and property reads | In-flight request drains; later requests use cached data |
| Reboot, reset-policy hardware handler, standalone screenshot | New requests return 503 / `MAINTENANCE_MODE`; admitted operations drain |
| Remote-control upgrade/viewers | New sessions refused; existing sockets closed and counted until close |
| scrcpy startup and teardown | Counted from admission through confirmed process exit, including late startup |
| Viewer screenshot loop | Stopped on drain; outstanding capture remains counted |
| Device health notifications | No new probes or synthetic offline observations during maintenance |

Metadata-only operations such as renaming devices remain available. Health
checks for the HTTP service remain available while the farm is paused.

## API

Authenticated clients can read `GET /api/maintenance`. Administrators can set
`PUT /api/admin/maintenance` with `{"requested":true}` or `{"requested":false}`.
The response includes `state` (`normal`, `draining`, `ready`), `requested`,
`runningJobs`, `activeOperations`, and `activeStreams`.

Docker on Linux remains experimental pending physical-device validation. See
[container installation](container.md); native/systemd remains recommended for
USB-connected farms. This guide is source content for the planned website docs;
website integration is tracked in [release readiness](../releases/release-readiness.md).
