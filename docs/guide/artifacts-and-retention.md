# Artifacts and retention

Every flow the farm runs is captured: what Maestro wrote, what it saw, and
what the screen was doing. This is the point of running on a real device
rather than reading a pass/fail bit.

## What gets captured

Maestro runs with `--debug-output` pointed at a scratch directory, and the
farm collects that directory afterwards, plus the flow's own output streams.

| Kind | Where it comes from | Typical files |
|---|---|---|
| `screenshot` | Maestro's debug output | `.png`, `.jpg`, `.jpeg` |
| `recording` | `adb shell screenrecord`, run by the farm | `.mp4`, `.webm` |
| `hierarchy` | Maestro's debug output | `.json`, `.xml` — view hierarchy dumps and `commands-*.json` |
| `log` | Maestro's debug output | `maestro.log` |
| `stdout` / `stderr` | The flow process itself | written by the farm |

Classification is by file extension alone, never by sniffing contents. A file
whose extension the farm does not recognise is **dropped**, not stored
unclassified — the farm will not risk rewriting bytes it does not understand.

`maestro.log` is usually the first thing to read on a failure: it is the
narrative of what the flow actually did, which is what you want once a
screenshot alone does not explain the result.

## Screen recordings

Every flow is screen-recorded automatically, capped at **180 seconds**. A
longer flow produces a truncated recording, not a missing one.

Recordings are served with HTTP Range support, which is not optional
decoration — Safari refuses to play `<video>` content at all without a
`206 Partial Content` response, and probes with a `Range: bytes=0-1` request
before it will start.

Collection is best-effort throughout. Losing a screenshot never turns a
passing flow red, and never fails a run: the artifacts matter most precisely
when the run already failed, so failing the run because they could not be
saved would be backwards. Problems surface as `warnings` on the step.

## Getting artifacts back

Artifacts are not in the CI response. `GET /run/:id` gives you verdicts and
captured stdout/stderr; anything richer goes through the dashboard routes.

```bash
# every step of a job, each with its artifact rows
curl -H "Authorization: Bearer $TOKEN" "$FARM_URL/api/jobs/$JOB" \
  | jq '.steps[] | {name, status, artifacts: [.artifacts[] | {id, kind, bytes}]}'

# one artifact's raw bytes
curl -H "Authorization: Bearer $TOKEN" "$FARM_URL/api/artifacts/1234" -o screenshot.png

# one step's log as plain text
curl -H "Authorization: Bearer $TOKEN" \
  "$FARM_URL/api/flow-runs/42/log?stream=stderr"
```

`Content-Type` is inferred from the file extension. Ownership is checked
through the job that owns the step that owns the artifact, so another org's
artifact id returns `404`, never someone else's bytes.

A coding agent can read the same artifacts through the [MCP tools](mcp.md),
which handle the size limits for you.

## Retention

**Off by default.** A fresh deployment keeps every job and every artifact
forever until an admin opts in.

An admin can set three thresholds in the dashboard's **Admin → Retention**
tab:

| Setting | Meaning |
|---|---|
| `maxAgeDays` | Delete jobs older than this |
| `maxTotalBytes` | Keep total artifact storage under this |
| `maxJobs` | Keep at most this many jobs |

Each is independently a non-negative integer, or `null` to disable that one.
Thresholds are **server-wide, not per-org** — a sweep triggered by one org's
volume evicts the globally oldest jobs, whoever they belong to.

Once a threshold is exceeded, a background sweep deletes the oldest jobs
first, removing both the job row and its artifact files.

⚠️ Eviction deletes **job history**, not just files. If your workflow treats
the farm as a durable record of past runs, say so before an admin enables a
threshold, and export what you need first.

`GET /jobs` returning at most 200 jobs is a separate thing — a response cap,
not a retention limit. Those jobs still exist.

## Disk usage

`GET /api/devices` reports `artifactBytes` at the top level of the
response — **farm-wide**, not per device: the live running total of
collected artifact storage across every device in the pool, independent of
whatever a retention sweep has already evicted. It is the number to watch if
retention is off.
