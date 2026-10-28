# Work-profile isolation

DeviceYard Pro can run a job, or each flow of a job, inside a fresh, disposable
Android **work profile** that holds no accounts. The profile is removed afterwards.

```sh
deviceyard cloud app.apk flows/ --isolation per-job
```

## Why

A farm phone usually has a Google account signed in. A test of "Sign in with
Google" then sees that account instead of the first-run flow, and an account
added by one test stays on the phone for every later job. Clearing the app's
data does not help: the account belongs to the Android user, not to the app, and
it cannot be removed from the main user over adb without root. A work profile
starts empty, so the sign-in flow runs from a clean start.

## The setting

`isolation` is chosen by whoever submits the job, because only they know whether
their flows need a clean account state. It is not a device setting.

| Value | Meaning |
|---|---|
| `disabled` | The default. Jobs run exactly as they do without this feature; no profile is created. |
| `per-job` | One fresh work profile for the whole job, removed when the job ends. |
| `per-flow` | A fresh work profile for every flow, removed after each flow. |

Command line: `--isolation <mode>`. The multipart `POST /run` equivalent is the
`isolation` field. A value other than the three above is rejected. Job details
show the chosen mode.

Isolation is a **Pro** feature. Community and installations without an active
Pro licence reject anything other than `disabled`. Queued isolated jobs stay
queued if the licence expires or the installation switches to Community; they
are never run without isolation.

## What happens during a job

For `per-job` this happens around the whole job, for `per-flow` around each flow:

1. Any profile left over from an earlier job is removed.
2. A work profile is created and started.
3. The app is installed into the profile only. The main user's copy, if any, is
   left alone.
4. The flows run against the profile's copy of the app. Flows run unchanged: the
   same YAML that works with plain Maestro works here, including `launchApp`
   options and restarts inside a flow.
5. The profile is removed, also when the job fails or a flow times out.

Device preparation (waking the screen, dismissing the keyguard, closing dialogs)
still runs once per job against the main user, because the profile shares the
screen. The app's data in the main user is not cleared for isolated jobs, since
that copy is not the one under test.

The job shows how long each profile took to set up: on the device preparation
step for `per-job`, and on each flow for `per-flow` (the dashboard labels it
"Work profile"). Warnings about a profile are listed with the step's warnings.

If creating the profile fails, the job fails at that step with the adb output.
There is no retry and no fallback to the main user.

## What it costs

Each profile writes a lot to the phone's flash storage.

- `per-job` costs about 15-40 s and about 1.5 GB of device writes per job.
- `per-flow` costs that for every flow. A 27-flow suite writes about 40 GB.

For comparison, an idle phone writes about 1 MB per minute, and a farm phone
running ordinary jobs wrote about 37 GB per day in our measurements.

**Lifetime estimates.** These are estimates, not measurements: the wear of the
flash chip cannot be read without root, so they rest on assumed endurance
figures for a 128 GB phone (1,000-3,000 write cycles, 2-4x write amplification).
On those assumptions:

| Workload | Rough phone lifetime |
|---|---|
| Ordinary jobs only (about 37 GB per day) | 2.5-14 years |
| Plus 20 `per-job` runs per day | 1.3-8 years |
| Plus 5 `per-flow` suites per day | 4 months-2 years |

Farm phones are usually replaced after 3-5 years anyway, so `per-job` is an
acceptable cost for most teams, and heavy `per-flow` use is the real risk. Use
`per-flow` only for flows that need it. Submitting a `per-flow` job returns a
warning with this cost; the CLI prints it to stderr unless `--quiet` is set.

## Requirements

- **Pro**, with an active licence (see above).
- **A device that supports work profiles.** The device must report the
  `android.software.managed_users` feature, and must have no work profile that
  DeviceYard did not create (Android allows one managed profile per device; a
  corporate profile or Samsung Secure Folder blocks isolation). The Devices page
  shows "Work-profile isolation: supported / not supported / unknown" for each
  device.
- **A Maestro build that supports `--android-user`.** Stock Maestro cannot target
  a work profile: it starts the main user's copy of the app and acts on the main
  user. Isolated jobs therefore use a Maestro build that adds a
  `maestro test --android-user <id>` option, published at
  <https://github.com/nmehlei/Maestro> (release `cli-2.11.0-android-user.1`,
  based on Maestro 2.11.0). Set `DEVICEYARD_ISOLATION_MAESTRO` to the path of that
  build's `maestro` binary; the default is `maestro`. Only isolated jobs use it;
  every other job keeps running with the official Maestro. Without the option,
  the build behaves like the official release. A job whose Maestro does not
  support the option fails with a clear message.

### Launch argument limitation

On Android 12 and older, the `am` tool cannot pass a `Double` launch argument to
an app in another user. Arguments of type String, Boolean, Int, Long and Float
work. A `launchApp` with a `Double` argument fails in an isolated job with a clear
message ("pass the value as a String instead"); the value is never converted
silently.

## Waiting for a device

An isolated job is only assigned to a device that supports isolation. With none
available it waits, like device routing's "no matching device", and never runs
without isolation. The job page shows why:

| Reason | Shown as |
|---|---|
| `PRO_ISOLATION_REQUIRED` | Waiting for an active Pro license to run with work-profile isolation. |
| `NO_ISOLATION_CAPABLE_DEVICE` | Waiting for a device that supports work-profile isolation. |

## Cleanup

DeviceYard recognises the profiles it creates by their name prefix `deviceyard-`
and never touches any other user or profile.

- Pro removes leftover `deviceyard-` profiles before every job and when the
  runner starts.
- Community removes them only when the runner starts, never per job, so jobs
  without isolation run exactly as before. This clears a profile left behind by a
  crash even after a switch to Community or an expired licence.
- Maintenance mode needs nothing extra: it waits for the running job, and the job
  removes its profile when it ends.

## Known limits

- Every profile looks like a new device to Google. In four test sign-ins none
  met a Google challenge, but that is a small sample and a challenge may appear
  with frequent use; a challenged sign-in fails the flow visibly.
- Only a Samsung Galaxy S10 on Android 12 was tested. Other makers may show
  extra prompts when a profile starts.
- Isolation gives a clean account state for the app under test. It does not reset
  the main user's accounts.
