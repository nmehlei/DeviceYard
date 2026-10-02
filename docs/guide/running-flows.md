# Running flows from CI

This guide takes you from nothing to a working pipeline step. If you only
want the endpoint contracts, see the [API reference](api-reference.md).

## The short version

Most pipelines should use the [`deviceyard` CLI](cli.md), which does
everything below — archiving, flow enumeration, polling, verdict extraction
and exit-code mapping — in one command:

```bash
export DEVICEYARD_URL=https://mobile-farm.example.com
export DEVICEYARD_API_KEY=$FARM_TOKEN     # an org token

npx --yes @deviceyard/cli@latest cloud app-testing.apk e2e/scenarios
# exits 0 if every flow passed, 2 if one failed, 1 if the farm could not run it
```

The rest of this guide is the raw HTTP underneath it — worth reading if you
are debugging, building your own client, or deliberately avoiding an install.

## 1. Get a token

Every request needs a bearer token. There are two kinds, and for CI you want
the first:

- **Org token** — one credential per org, shared by everyone and everything
  in it. It fixes the org by definition, so a request carrying it never has
  to say which org it is for. This is what CI uses.
- **Personal access token (PAT)** — one credential per person, valid across
  every org they belong to. Needs an `X-Org-Id` header on every call to say
  which org the request is for. This is for humans and agents, not
  pipelines. See the [MCP guide](mcp.md).

To create an org token: log into the dashboard, open your org's page, and
use the tokens panel. Store it in your pipeline's secret store — Azure
DevOps variable groups, GitHub Actions secrets, whatever you already use.

> `TOKENS_JSON` on the server is **not** where tokens live any more. It
> seeds the token table once, on a first boot against an empty database.
> After that, tokens are created and revoked through the dashboard, and
> changing `TOKENS_JSON` has no effect on an existing deployment.

## 2. Build the two uploads

`POST /run` takes two files.

**The testing APK** — the instrumented build Maestro drives. Whatever your
existing `assembleAndroidTest`-equivalent step already produces.

**The flows archive** — a `.tar.gz` of your `e2e/` directory, containing
both `scenarios/` and any `shared/` files your flows reference:

```bash
tar -czf e2e.tar.gz -C /path/to/repo e2e
```

The archive is extracted server-side, so relative references between your
flows keep working exactly as they do locally.

## 3. Name the flows to run

`flows` is a JSON-encoded array of flow identifiers: paths under
`e2e/scenarios`, without the `.yaml` extension.

```
e2e/scenarios/map.yaml          ->  "map"
e2e/scenarios/map/filter.yaml   ->  "map/filter"
```

They run **in the order you list them**, one after another, on the same
device without reinstalling between flows.

## 4. Submit the job

```bash
JOB=$(curl -sf -X POST "$FARM_URL/run" \
  -H "Authorization: Bearer $FARM_TOKEN" \
  -F apk=@app-testing.apk \
  -F flowsArchive=@e2e.tar.gz \
  -F flows='["map/map","map/filter"]' \
  | jq -r .id)
```

You get `202 Accepted` with `{ "id": "...", "status": "queued" }` as soon as
the uploads land. The job has not started yet — it runs as soon as any
enrolled device is free. Several devices can be enrolled at once, so multiple
jobs can run concurrently across the pool (subject to an optional
`maxConcurrentJobs` cap an admin can set); a job only serializes behind
others if every enrolled device is currently busy, or the cap is reached.

Before it accepts, the farm installs the APK, clears and force-stops the app
under test, and extracts your archive. A failure in any of those is reported
as a job failure, not an HTTP error, because by then you already have a job
id.

**The APK you upload always wins.** The farm installs what you gave it, even
when the build already on the device has a higher `versionCode` — it passes
`-d`, and falls back to uninstalling and installing fresh when Android refuses
the downgrade outright (which it does for release-signed APKs). This matters
if your `versionCode` comes from a CI build number: without it, a locally
built APK could never replace a pipeline-built one, and there is no uninstall
endpoint to dig yourself out with. Nothing is lost by the reinstall — the app's
data is cleared before every job regardless.

## 5. Poll until it finishes

```bash
while :; do
  BODY=$(curl -sf -H "Authorization: Bearer $FARM_TOKEN" "$FARM_URL/run/$JOB")
  STATUS=$(echo "$BODY" | jq -r .status)
  case "$STATUS" in
    done|failed) break ;;
  esac
  sleep 10
done
```

The four statuses, and what each means for your pipeline:

| `status` | Meaning | What to do |
|---|---|---|
| `queued` | Accepted, waiting for the device | Keep polling |
| `running` | Executing your flows now | Keep polling |
| `done` | Every flow ran to a verdict | **Check `results[].passed` — this does not mean they passed** |
| `failed` | The runner itself broke | Read `.error`; this is a farm problem, not a test failure |

The `done` / `failed` distinction is the one worth internalising. `done`
means the machinery worked; whether your tests passed is a separate
question, answered per flow in `results`. `failed` means the farm could not
get as far as a verdict — device offline, APK install failed, archive
unreadable.

## 6. Decide pass or fail

```bash
echo "$BODY" | jq -e 'all(.results[]; .passed)' >/dev/null \
  || { echo "$BODY" | jq -r '.results[] | select(.passed|not) | .flow'; exit 1; }
```

Each entry in `results` carries the flow's identifier, its verdict, and its
captured `stdout` and `stderr`:

```json
{
  "id": "0f3c…",
  "org": "momentum",
  "flows": ["map/map", "map/filter"],
  "status": "done",
  "results": [
    { "flow": "map/map",    "passed": true,  "stdout": "…", "stderr": "" },
    { "flow": "map/filter", "passed": false, "stdout": "…", "stderr": "…" }
  ],
  "createdAt": 1756800000000
}
```

**Setup failures look different.** If the farm failed before reaching your
flows, `results` holds exactly one pseudo-entry named for the stage that
broke — `<device>`, `<install>` or `<extract>` — with `passed: false`. A
pipeline that prints failing flow names will print one of those instead, and
that is the intended signal: the angle brackets say "this was not your test".

## 7. A complete pipeline step

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${FARM_URL:?}" "${FARM_TOKEN:?}"

tar -czf e2e.tar.gz -C "$(git rev-parse --show-toplevel)" e2e

JOB=$(curl -sf -X POST "$FARM_URL/run" \
  -H "Authorization: Bearer $FARM_TOKEN" \
  -F apk=@app-testing.apk \
  -F flowsArchive=@e2e.tar.gz \
  -F flows="$FLOWS" \
  | jq -r .id)

echo "job $JOB queued"

DEADLINE=$(( $(date +%s) + 1800 ))
while :; do
  BODY=$(curl -sf -H "Authorization: Bearer $FARM_TOKEN" "$FARM_URL/run/$JOB")
  STATUS=$(echo "$BODY" | jq -r .status)
  [[ "$STATUS" == done || "$STATUS" == failed ]] && break
  if (( $(date +%s) > DEADLINE )); then
    echo "timed out after 30m waiting for job $JOB (last status: $STATUS)" >&2
    exit 1
  fi
  sleep 10
done

if [[ "$STATUS" == failed ]]; then
  echo "farm error: $(echo "$BODY" | jq -r .error)" >&2
  exit 1
fi

echo "$BODY" | jq -r '.results[] | "\(if .passed then "PASS" else "FAIL" end)  \(.flow)"'
echo "$BODY" | jq -e 'all(.results[]; .passed)' >/dev/null
```

Give the wait loop its own deadline. The farm will not time your job out for
you, and a wedged device otherwise holds your pipeline open indefinitely.

## Common failures

| Symptom | Cause |
|---|---|
| `401 {"error":"missing bearer token"}` | No `Authorization` header, and no `?token=` fallback |
| `403 {"error":"invalid token"}` | Token unknown or revoked |
| `403 {"error":"this token belongs to a person…"}` | You used a PAT without `X-Org-Id` — for CI, use an org token |
| `413 {"error":"apk exceeds the upload limit of …"}` | Your APK is above the configured cap (512 MB by default). An admin can raise it under Admin → Uploads; no restart needed |
| `503 {"error":"no device is enrolled…"}` | The pool is empty — no device enrolled at all; an operator must add and enable one. Never returned just because every enrolled device is busy; the job queues instead |
| `404 {"error":"job not found"}` on a job you created | Wrong org's credential. Job ids are scoped to the owning org |
| Job goes `failed` with an install error | The app id is read from your own uploaded APK's manifest now, not a configured value - a genuine install-level failure here means something else, e.g. a signature conflict with a different app already installed under the same package name |
| `400 {"error":"…not a recognizable APK"}` (or `…not a valid zip file`) on `POST /run` | The uploaded `apk` file isn't a readable APK/IPA - the farm reads the package name from its manifest before the job is even queued, so a corrupt or wrong file is rejected up front rather than failing mid-run |

## What you get afterwards

Every flow's screenshots, screen recording, view hierarchy dumps and
`maestro.log` are collected and kept. See
[Artifacts and retention](artifacts-and-retention.md).

## Next

- Passing values into your flows: [Environment variables](environment-variables.md)
- Watching a run live instead of polling: [Dashboard](dashboard.md)
