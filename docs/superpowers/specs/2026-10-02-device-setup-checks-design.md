# Device setup checks: adb authorization timeout, adb install verification

Date: 2026-10-02

## Problem

On 2026-10-02 the farm's Galaxy S10 came back from a reboot as
`unauthorized` and stayed that way until someone physically unlocked it and
re-accepted the USB debugging prompt. The host's adb key had not changed
since 2026-08-10, and "Always allow from this computer" had been ticked every
previous time - the operator reported being asked "multiple times" anyway.

The device had `adb_allowed_connection_time` unset, i.e. Android 11+'s default
7-day authorization timeout. An "Always allow" grant expires once its
last-recorded connection is older than that, which on a handset left plugged
in for weeks is exactly what a reboot runs into. Setting the value to `0`
("Disable adb authorization timeout" in Developer options) removes the expiry.

Nothing about this is visible in DeviceYard today. An `unauthorized` device
fails every job until a human is in the room, and the farm cannot recover it
remotely: approving the prompt needs the screen, and `adb root` / changing
`ro.adb.secure` is not available on a stock device.

The same day, three consecutive jobs for one app build (Firstful
`0.1.0-dev (1)`, a local debug build) each hung in `adb install` for the full
15-minute timeout, while signed builds of the same app and another app
installed in seconds on the same device. The suspected cause is Play
Protect's "Verify apps over USB" (`verifier_verify_adb_installs`, unset =
enabled on the farm device): for an app it does not recognise, the
verification can block on an on-screen prompt nobody is there to answer.
**This is not yet confirmed** - the APK and the device log from those runs
were gone by the time it was investigated. It must be confirmed (disable the
setting, re-run that build) before implementation; if it does not
reproduce, the second check is dropped from this spec.

## Goals

1. Document both settings as requirements for every farm device.
2. Warn in the dashboard when an authorized device is not configured that way.
3. Let an admin fix it from the dashboard.

## Decisions

- **D-1 Manual fix only.** The runner never changes device settings on its
  own - not on enable, not before jobs. Warning + admin action keeps the
  behaviour explicit and in the audit log. (Chosen over auto-apply on enable
  and auto-apply in `prepareDevice`.)
- **D-2 A generic setup-checks list, starting with two checks.** The API
  exposes `setupChecks: [...]` rather than a dedicated boolean per setting,
  so a further check (e.g. animation scales, stay-awake) adds an entry, not
  an API shape change. (Chosen over a dedicated field + route, and over an
  on-demand endpoint that would only warn when someone happened to look.)
- **D-3 Read on the existing poll, in the existing adb call.** No extra adb
  process per device per poll.
- **D-4 A fix is only reported as successful after a read-back.**

## Design

### 1. Check registry - `src/deviceSetupChecks.ts` (new)

```ts
export interface DeviceSetupCheck {
  id: string;                 // stable, URL-safe: "adb-auth-timeout"
  title: string;              // "USB debugging approval expires"
  detail: string;             // one sentence: consequence of not fixing it
  readArgs: readonly string[]; // adb shell argv printing the current value
  isOk(output: string): boolean;
  fixArgs: readonly string[];  // adb shell argv applying the fix
}
export const SETUP_CHECKS: readonly DeviceSetupCheck[];
```

The checks:

| field | `adb-auth-timeout` | `adb-install-verification` |
|---|---|---|
| title | USB debugging approval expires | Play Protect verifies adb installs |
| detail | The device forgets this host's USB debugging approval after 7 days; after a reboot someone must accept the prompt on the device again. | Play Protect may stop an install from this host to show a prompt on the device, hanging the job until it times out. |
| readArgs | `settings get global adb_allowed_connection_time` | `settings get global verifier_verify_adb_installs` |
| isOk | trimmed output is exactly `0` (`null` or any other number is not ok) | trimmed output is exactly `0` (`null` means the default, i.e. enabled) |
| fixArgs | `settings put global adb_allowed_connection_time 0` | `settings put global verifier_verify_adb_installs 0` |

Empty output is never "not ok": `settings get` prints the literal `null` for
an unset value, so an empty section means the read itself failed and the
result is `null` (unknown).

The probe is passed to `adb shell` as separate argv tokens with `;` tokens
between commands; adb joins them with spaces and the device shell runs the
result. Verified on the farm S10 on 2026-10-03: output is the model line,
then each marker line followed by its value.

`adb-install-verification` is deliberately the narrow setting ("Verify apps
over USB" in Developer options), not Play Protect as a whole
(`package_verifier_enable`): Play Store installs and on-device scanning stay
protected; only installs pushed by the farm host skip the check. Google Play
services may reset the value; the poll then raises the warning again, which
is the intended signal.

Also exported from the module:

- `buildProbeScript(checks)` - one shell script that prints the model
  (`getprop ro.product.model`) and each check's output between marker lines
  (`__DY_CHECK_<id>__`). Commands are fixed strings from the registry; no
  caller input reaches the shell.
- `parseProbeOutput(stdout, checks)` -> `{ model?: string; results: Map<id, boolean | null> }`.
  A check whose marker is missing or whose section is unparseable is `null`
  ("unknown"), never `false`: a flaky read must not raise a false warning.

### 2. Device list - `GET /api/devices` (`src/api/devices.ts`)

Today each `device`-state entry runs `adb -s <id> shell getprop ro.product.model`.
That call is replaced by one `adb -s <id> shell <probe script>`. The model is
taken from its first section, so model caching behaves exactly as before.

Each entry gains:

```ts
setupChecks: { id: string; title: string; detail: string; ok: boolean | null }[]
```

- One entry per registered check, always present (stable shape).
- `ok: null` when the device is not in state `device`, or the probe failed or
  timed out (`DEVICE_STATUS_TIMEOUT_MS`, unchanged). As with `getprop` today,
  a failed probe never fails the list.

`shared/apiTypes.ts` `DeviceEntry` and `dashboard/src/lib/api.ts` `DeviceEntry`
gain the field.

### 3. Fix - `POST /api/devices/:id/setup-checks/:checkId/fix`

In order:

1. `hardware()` wrapper (edition policy), like reboot.
2. Not admin -> 403 `admin access required`.
3. Unknown device -> 404 `unknown device`; unknown `checkId` -> 404 `unknown setup check`.
4. Device not live in state `device` (via `adb devices`) -> 409 `device is not connected and authorized`.
5. Run `fixArgs`; non-zero exit -> 502 with adb's stderr.
6. Run `readArgs`; `isOk` false -> 502 `setting did not take effect (read back: <value>)`.
7. Record device event kind `setup_fix`, detail
   `"<check title>" fixed by <actor>` (actor via existing `actorOf`).
8. 200 `{ check: { id, title, detail, ok: true } }`.

Allowed while a job runs: a single settings write does not disturb a flow, and
refusing would make the fix unusable on a busy device.

`DeviceEventKind` gains `"setup_fix"`; the dashboard's event log renders it
with a generic label.

### 4. Dashboard

**`DeviceCard.tsx`:** for each check with `ok === false`, an amber notice
block below the hardware list:

- title, detail, and a pointer to "Required device settings" in the operating
  guide (plain text: the dashboard has no hosted docs to link to);
- admins: a **Fix** button -> `fixDeviceSetupCheck(deviceId, checkId)` through
  the card's existing `runOp` (busy state, error slot, `onChanged()` refresh);
- non-admins: "Ask an admin to fix this." and no button.

No confirmation dialog: the change is safe and reversible from Developer options.

**Devices page summary:** when any device has a failing check, an extra
"Needs setup - N device(s)" tile in the existing summary row (next to
"Needs authorization"), so a warning on a card below the fold is not missed.
Hidden when N is 0.

### 5. Documentation

- `docs/guide/operating.md`, under "Adding a device": a new
  "Required device settings" subsection - for each check: what the setting
  is, why it matters (this incident), how to set it (Developer options
  toggle, or the `adb shell settings put global ...` command), and that the
  dashboard warns and can fix it.
- `SETUP_INSTRUCTIONS` in `src/api/devices.ts` (shown when adding a device):
  a step to disable the adb authorization timeout and "Verify apps over USB".
- `docs/guide/dashboard.md`: the warning and Fix button.
- `docs/guide/api-reference.md`: the `setupChecks` field and the fix route.

## Error handling

| situation | result |
|---|---|
| device `unauthorized` / `offline` | `ok: null`, no warning; existing "accept the prompt" hint stays |
| probe times out or exits non-zero | `ok: null` for every check on that device; list still 200 |
| marker missing in probe output | that check `ok: null` |
| fix command fails | 502 with adb stderr, no event recorded |
| fix command "succeeds" but read-back not ok | 502, no event recorded |

## Testing

Backend (Jest, fake `CommandRunner`):

- `parseProbeOutput`: `0` -> true; `null`, `604800000` -> false; empty section -> null;
  missing marker -> null; model extracted.
- `GET /api/devices`: a `device`-state entry carries `setupChecks` from the
  probe; `unauthorized` entry has `ok: null`; a probe that throws leaves the
  list at 200 with `ok: null`; exactly one shell call per device (the
  getprop call is replaced, not added to).
- Fix route: 403 non-admin, 404 device, 404 check, 409 not connected,
  502 fix fails, 502 read-back not ok (no event), 200 success with
  `setup_fix` event and the exact fix command issued.

Dashboard (existing component test setup):

- warning renders only for `ok === false` (not `null`, not `true`);
- Fix button only for admins; clicking calls the fix API and triggers refresh;
- summary tile count, hidden at 0.

Every new test is checked against "would this fail if the feature were
reverted?" - in particular, the read-back test must fail if step 6 is removed.

## Out of scope

- Auto-applying the setting anywhere (D-1).
- Any check other than `adb-auth-timeout` and `adb-install-verification`.
- Disabling Play Protect as a whole (`package_verifier_enable`).
- Recovering an already-`unauthorized` device remotely (not possible without root).
- The runner bugs found in the same incident (install inheriting the 15-minute
  Maestro timeout; a timeout kill reported as `failed to launch "adb"`;
  uploaded APKs left in `/tmp`) - separate change.
