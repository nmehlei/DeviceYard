# Operating the farm

This repo holds the application code. The VM, DNS record and deployment
scripts live in [NME-IaC's `solutions/mobile-device-farm`
playbook](https://github.com/nme/NME-IaC/tree/main/solutions/mobile-device-farm),
which deploys it as a systemd service.

## API discovery

The service publishes the OpenAPI 3.1 document for its deployed version at
`GET /openapi.json`. This endpoint is intentionally unauthenticated and contains
contract metadata only. A self-hosted Swagger UI viewer is available at
`GET /api-docs`, with no CDN or external service dependency. Protected
operations still enforce their documented authentication requirements.

## Configuration

All configuration is environment variables. The service **refuses to start**
on a missing or malformed required value, with a message naming the variable
— never echoing its value.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `TOKENS_JSON` | yes | — | `{org: token}` JSON map. **Seed only**: it backfills the org and token tables once, on a first boot against an empty database. After that, tokens are managed through the dashboard and changing this has no effect. Malformed JSON fails fast with a clear message rather than a raw `SyntaxError`. |
| `DEVICE_ID` | yes | — | `adb` serial of the target device. Seeds the `devices` table's first row on a fresh `DATA_DIR`; after that, which device jobs run against is whichever row is active, not this value. |
| `SESSION_SECRET` | yes | — | HMAC key signing the dashboard session cookie. **At least 32 characters** — the service refuses to start otherwise, since a short key makes offline forgery of a session cookie practical. Never logged. |
| `ADMIN_USERNAME` | yes | — | The one admin account seeded on first boot, when `users` is empty. |
| `ADMIN_PASSWORD` | yes | — | Password for that account. Never logged. Change it, or create a second admin and deactivate this one, after first login — this value stays readable in whatever secret store holds the service's env, indefinitely. |
| `ADMIN_EMAIL` | yes | — | Email for that account (`users.email` is `NOT NULL UNIQUE`). |
| `TOKEN_ENCRYPTION_KEY` | yes | — | AES-256-GCM key encrypting every token at rest. **Exactly 64 hex characters (32 bytes)** — `openssl rand -hex 32`. See the warning below. |
| `PORT` | no | `8080` | HTTP listen port. |
| `UPLOAD_DIR` | no | OS temp dir | Where uploaded APKs and flow archives, and their extraction directories, are staged. |
| `DATA_DIR` | no | `/opt/mobile-device-farm/data` | SQLite database (`farm.db`) and collected artifacts. **Must be outside the deploy bundle directory** — the update timer replaces that directory wholesale on every merge to `main`, so a `DATA_DIR` inside it is deleted on every deploy. |
| `CONTROL_FRAME_INTERVAL_MS` | no | `1000` | Floor between screen captures for an admin's [live view](remote-control.md), in milliseconds; minimum 100. **Not a frame rate** - capturing a frame takes the device 0.8-2.8s depending on its load, and that is what bounds the effective rate. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | — | Enables OpenTelemetry export when set; absent means no SDK starts at all. See [Observability](observability.md). |
| `OTEL_SERVICE_NAME` | no | `mobile-device-farm` | `service.name` on emitted telemetry. |
| `OTEL_TRACE_DB` | no | off | `1` adds a span per SQLite query. Diagnostic only — see [Observability](observability.md). |

### ⚠️ `TOKEN_ENCRYPTION_KEY` is not safely rotatable

Losing or rotating this key makes every already-stored token undecryptable.

The failure mode is deceptive: CI's bearer-token auth keeps working
unaffected, because the lookup is a SHA-256 hash comparison rather than a
decryption. Nothing looks broken. But `GET /api/orgs/:id/tokens` — the
dashboard's "view or copy your token" UI — errors for every existing token,
and an operator can easily miss that anything is wrong until someone tries to
copy one.

Treat it with the same care as `SESSION_SECRET`, and back it up before ever
rotating it.

## Adding a device

Devices are a **pool** — any number can be registered and enrolled at once,
and jobs run concurrently across whichever are enrolled and free. There is no
single "the active device" to swap between.

1. Connect the phone to the farm host over USB.
2. On the device, enable Developer Options and turn on USB debugging.
3. Run `adb devices` on the host and accept the debugging prompt on the
   device screen.
4. Confirm the serial `adb devices` prints matches the id you register —
   that serial is the device's permanent identity.
5. Register it at `/devices`, then use **Enable** on its card to add it to
   the pool jobs are scheduled against.

Registration performs no adb calls of its own; it just records the serial.

### Required device settings

Two Developer Options settings must be set on every farm device. The
dashboard checks both on every poll and shows a warning on the device card
when either is wrong; an admin can fix it there with **Fix** (recorded in the
device's activity log as `setup_fix`). DeviceYard never changes them on its
own.

| Check | Developer Options | adb equivalent |
|---|---|---|
| USB debugging approval expires | **Disable adb authorization timeout** - ON | `adb shell settings put global adb_allowed_connection_time 0` |
| Play Protect verifies adb installs | **Verify apps over USB** - OFF | `adb shell settings put global verifier_verify_adb_installs 0` |

**Why the authorization timeout matters.** Android 11+ drops an "Always allow
from this computer" grant once its last recorded connection is 7 days old. A
farm phone stays plugged in for weeks, so after a reboot it can come back
`unauthorized` - and recovering that needs someone in front of the device to
accept the prompt again. It cannot be done remotely without root. Seen on the
farm's S10 on 2026-10-02.

**Why adb install verification matters.** With "Verify apps over USB" on,
Play Protect checks each APK the farm installs. For a build it does not
recognise (a local debug build, for example) that check can stop on an
on-screen prompt, and the job's install step hangs until it times out. Only
installs pushed by the farm host skip the check; Play Protect itself stays
on. Google Play services may switch it back on; the warning then reappears.

The check can only read an authorized device: for an `unauthorized` or
offline device the card shows no setup warning, only the existing "accept the
USB debugging prompt" hint.

### Enable, disable, remove

- **Enable** adds a device to the pool. Safe at any time — enabling a free
  device disrupts nothing.
- **Disable** drains a device: it finishes whatever job it currently holds,
  but is never claimed for a new one after that. It does **not** interrupt a
  running flow, so switching a device out of rotation no longer needs the
  farm to go idle first.
  ⚠️ Disabling the last enrolled device (or all of them at once) strands any
  job still `queued`: there is no device left to claim it, no timeout fires,
  and it never reaches a terminal status — `GET /run/:id` reports `queued`
  forever, and CI polling it falls back to its own timeout. Recovery is
  re-enabling a device (it will pick the job up) or restarting the service
  (the boot-time sweep closes it, the same as any other queued job a restart
  interrupts).
- **Remove** deletes a device's row entirely. It only succeeds once the
  device is disabled and holds no running job (`409` otherwise) — this closes
  the earlier "no way to remove a registered device" gap.

`Activate` still works as a deprecated alias for `enable` (kept only so a
dashboard tab open from before an upgrade keeps working) — prefer
Enable/Disable in anything new.

### The `maxConcurrentJobs` cap

**Admin → Scheduler** sets an optional ceiling on how many jobs run at once,
independent of how many devices are enrolled — useful when the farm host
itself (not the phones) is the bottleneck, e.g. CPU-heavy `adb`/Maestro
overhead per concurrent session, or when you want headroom before adding the
next device rather than immediately saturating it. `null` (the default)
means no cap — every enrolled, free device gets used. Lower it when the jobs
your enrolled devices could physically run are competing for host resources
faster than the host can keep up (visible as jobs staying `queued` behind
others despite devices reporting `state: "device"`, or the host visibly
struggling under concurrent `adb`/Maestro sessions) — it does not free up a
struggling device, only how many can be busy across the whole pool at once. A saved
change is read per dispatch, not held from startup, so it takes effect
immediately, mid-queue.

## Retention

Off by default — a fresh deploy keeps everything forever. Configure
thresholds under **Admin → Retention**. They are server-wide, not per-org, so
a sweep triggered by one org's volume evicts the globally oldest jobs
whoever they belong to, deleting both job rows and artifact files.

Watch `artifactBytes` (visible at `/devices`, farm-wide across every device,
not per-device) to decide whether you need it. See
[Artifacts and retention](artifacts-and-retention.md).

## Upload size limit

`POST /run` caps each uploaded file. The cap is **not** an environment
variable — it lives in the database and is edited under **Admin → Uploads**,
so raising it is an ops action rather than a deploy. That matters: the person
who needs to raise it is doing so because a legitimate build is being
rejected, usually at an inconvenient moment.

| State | Enforced |
|---|---|
| Nothing ever saved | **512 MB** (the built-in default) |
| A value saved | That value |
| Field cleared to empty | No limit at all |

The default is deliberate. A fresh install and every existing deployment pick
up the cap without an admin doing anything — a protection nobody has opted
into protects nobody, and nobody opts into a limit they have not yet been
bitten by. 512 MB sits comfortably above a fat multi-architecture debug
testing APK (150–300 MB is typical), so it does not break real pipelines.

Clearing the field restores unbounded uploads. It is kept as an escape hatch
on purpose: a cap that cannot be removed is a blocked release at 3am. The
card warns when the field is empty.

A saved change takes effect on the **next request** — the limit is read per
request, not held from startup. An over-cap upload gets a `413` naming both
the field and the limit, and leaves nothing on disk.

## Operational characteristics worth knowing

- **Single process, a pool of devices.** Jobs run concurrently across
  however many devices are enrolled (subject to `maxConcurrentJobs`), but the
  process itself does not scale horizontally — a job is bound to a device
  only when the scheduler claims it, so a second process pointed at the same
  `DATA_DIR` is not a supported way to get more capacity (see the
  single-instance warning on `failQueuedWithoutPayload()` in
  `src/store/jobRepository.ts`). An uncaught exception still takes the whole
  farm down, including CI, which is why the artifact and file routes are so
  careful with stream error handling.
- **Queued jobs survive restarts.** Accepted uploads and execution inputs are
  stored privately under `DATA_DIR/job-inputs`. Back up this directory together
  with the database. Use [maintenance mode](maintenance.md) to drain running
  jobs before an upgrade and explicitly resume afterwards. Older releases'
  transient uploads cannot be recovered retroactively.
- **Flows get a 15-minute timeout** (`DEFAULT_TIMEOUT_MS`). Device status
  checks get their own 5-second budget instead, so a wedged device cannot
  hold an ops endpoint for a quarter of an hour.
- **`DATA_DIR` survives deploys, the bundle does not.** This is the single
  most important operational fact about the layout.

## Development

```bash
npm install
npm test
npm run build
npm run build:mcp                              # the bundled MCP client
cd dashboard && npm install && npm run build   # dashboard static export
cd ..
npm start
```

`npm start` needs `TOKENS_JSON`, `DEVICE_ID`, `SESSION_SECRET`,
`ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_EMAIL` and `TOKEN_ENCRYPTION_KEY`.

See [Contributing](../../CONTRIBUTING.md) for local development, validation,
and the Community/Pro source boundary.

## Email notifications

Email delivery is optional and uses any compatible SMTP relay. See
[Notifications](notifications.md#smtp-setup) for environment variables,
sender configuration, local testing, delivery status, and retry/retention rules.
