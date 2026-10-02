# Remote control

Watch an enrolled device's screen from the dashboard, in real time, and — when
the device is idle — take control of it: tap, drag, scroll, and type as if you
were holding the phone.

Open **Devices**, find the phone, and press **Open screen** on its card. That
opens a dedicated page with a URL you can share with a teammate — anyone with
access to the dashboard who follows the link sees the same device.

## Who can use it

Farm admins only. Remote control is not available to org members, even for a
device that is running their own job.

This is deliberate. A live screen shows whatever is on the phone at that
moment, which on a shared farm may be another org's app state — a logged-in
session, a test account's data, a screen mid-flow. Running a flow is
sandboxed by comparison: it gets a cleared app and hands back only its own
artifacts. Watching the screen is not, so it stays with the people who
already administer the device. Taking control goes further still — it can
change what's on the device — so the same restriction applies with even more
reason.

An org member who opens the socket receives *This screen is available to
farm admins only*, not a generic connection error.

## The three modes

The view always carries a label and, for the two snapshot modes, the reason
for it:

| Label | Reason shown | What it means |
|---|---|---|
| **Snapshot view** | idle | No job is running. Still frames only. |
| **Snapshot view** | a job is running | A job currently holds this device. Still frames only. |
| **Live control** | — | Someone (possibly you) is in control of the device. |

Only an idle device — **Snapshot view — idle** — can be taken over. The
**Take control** button appears only in that mode; a device running a job, or
already under someone else's control, does not offer it.

## What you can do in control

Once you take control, the sidebar exposes:

- **Tap, drag, and scroll** directly on the streamed screen.
- **Hardware keys**: Back, Home, Recents, Power, Volume up/down.
- **Typing**, including non-ASCII text (the input field accepts any Unicode
  text and forwards it to the device, not just the keys physically on your
  keyboard).
- **Rotate**, to switch the device between portrait and landscape.

## CI wins: the 60-second countdown

The farm still needs to run jobs. If a job is waiting for a device while you
hold control of it, the sidebar shows a countdown: *A job is waiting for this
device — control releases in 0:59* (counting down). You can:

- Press **Release now** to end your session immediately and let the job
  start right away, or
- Do nothing, and control releases automatically when the countdown reaches
  zero — the job then starts.

There's no way to hold control indefinitely against a waiting job. This is
intentional: CI throughput doesn't wait on someone leaving a debugging
session open.

## For longer work, disable the device first

If you need the device for more than a minute or two — debugging, manual
exploration, anything where a sudden 60-second countdown would be disruptive
— **disable the device** first (the **Disable** button on the device card).
A disabled device cannot be scheduled for jobs, so no job can ever be
waiting for it, and no countdown starts while you're in control. Re-enable
the device when you're done so the scheduler can use it again.

## Why mid-job viewing is still frames

While a job is running, the screen is still frames about a second apart
rather than video, and control is not available. That is a deliberate
trade.

Video would mean a second hardware encoder session on the phone, running
alongside the `screenrecord` that captures every job's `recording.mp4`. On
some devices a second encoder session simply fails — and the thing that would
break is the *job's* recording, silently, leaving a missing artifact behind.
That is CI evidence damaged by somebody opening a browser tab.

The still-frame path uses a different mechanism entirely (a SurfaceFlinger
read, no encoder, no virtual display), so it cannot interfere with a
recording no matter what else is happening on the device. Watching a job is
therefore always safe — it just can't be interactive.

## Browser requirement

Live control decodes real-time video using WebCodecs. That means a current
version of Chrome, Edge, Safari, or Firefox. Without WebCodecs support, the
page falls back to snapshot viewing only — the **Take control** button does
not appear, and the sidebar says the browser can't decode live video.

## If a control session fails to start

When taking control fails to start, the farm kills any `scrcpy-server`
process on that phone as part of cleanup — including one started by hand
outside the farm (e.g. while debugging directly over `adb`). Don't leave a
manually-started `scrcpy` session running on a farm device if you need it to
survive a take-control attempt from the dashboard.

## Leaving

Closing the tab releases control immediately. If your connection drops
without a clean close — network loss, laptop sleep — the device notices the
dead connection and releases control within 30 seconds.

## Cost and load

Each snapshot frame is a full-resolution PNG, around 380 KB on a 1080×2316
screen, so a snapshot session uses roughly 3 Mbit/s. Live control streams
video instead, so bandwidth is comparable to a video call. Worth knowing
before leaving a tab open on a metered connection.

The farm captures **only while somebody is watching**, and runs exactly one
capture loop per device however many admins are watching it. An unwatched
device does no capture work at all.

Starting and stopping a session, and taking or releasing control, is
recorded in the device's event log, so it is visible to anyone else looking
at that phone.

## Configuration

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `CONTROL_FRAME_INTERVAL_MS` | no | `1000` | Floor between snapshot captures, in milliseconds. Must be at least 100. Not a frame rate — the device's own capture time bounds the effective rate. Does not apply to live control's video stream. |

## Requirements

Remote control uses a WebSocket on the same origin as the dashboard. A
reverse proxy in front of the farm must allow WebSocket upgrades on
`/api/devices/*`; without that the view reports that it disconnected and
never shows a frame.

## Attribution

The device-side component that streams and injects input during live
control is [scrcpy](https://github.com/Genymobile/scrcpy)'s server,
version 3.3.2, licensed under the Apache License 2.0, © Genymobile. See
`vendor/scrcpy/LICENSE` for the full license text.
