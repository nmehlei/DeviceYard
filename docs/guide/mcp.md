# MCP server — pointing a coding agent at the device

A coding agent can run flows on the physical device and read back the
evidence itself, without a human relaying screenshots or babysitting CI. The
farm serves its own MCP client: a single bundled file with no `node_modules`
to install.

## Setup

### 1. Create a personal access token

Log into the dashboard, open **Account settings**, and create a personal
access token (PAT).

A PAT is one credential for one person, valid across **every org they belong
to** — unlike an org token, which is one credential per org shared by
everyone in it. That difference is the whole reason PATs exist: if you work
in two orgs, you do not want two MCP configs and two secrets on disk.

It is shown at creation and stays retrievable from the same dialog for as
long as it exists.

### 2. Download the client bundle

The bundle is served behind the same auth as everything else, which for a PAT
means naming an org with `X-Org-Id`. The download itself is not org-specific
— any org you belong to works. If you do not know an id yet,
`GET /api/me/orgs` accepts a PAT with no org header at all, because it is the
discovery call:

```bash
mkdir -p ~/.mobile-farm

curl -s -H "Authorization: Bearer $MOBILE_FARM_PAT" \
  "$FARM_URL/api/me/orgs"
# -> {"orgs":[{"id":1,"name":"example-team"},{"id":2,"name":"another-team"}]}

curl -fsSL -H "Authorization: Bearer $MOBILE_FARM_PAT" -H "X-Org-Id: 1" \
  "$FARM_URL/api/mcp-client" -o ~/.mobile-farm/mcp.mjs
```

Already have an org token? `curl -H "Authorization: Bearer $MOBILE_FARM_TOKEN"`
with no `X-Org-Id` works too — an org token fixes its org already.

### 3. Save the credential

Save the PAT to `~/.mobile-farm/credentials`, never into a per-repository
file. The client reads it **from stdin only** — never a command-line
argument, which would land in shell history and in `ps` output:

```bash
MOBILE_FARM_URL="$FARM_URL" node ~/.mobile-farm/mcp.mjs --save-credential
# paste the token, then Ctrl-D
#   or:  pbpaste | MOBILE_FARM_URL="$FARM_URL" node ~/.mobile-farm/mcp.mjs --save-credential
```

The file is written `0600`, enforced on overwrite as well as creation.

### 4. Point your harness at it

Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "mobile-farm": {
      "command": "node",
      "args": ["/Users/you/.mobile-farm/mcp.mjs"],
      "env": {
        "MOBILE_FARM_URL": "https://mobile-farm.example.com",
        "MOBILE_FARM_ORG": "example-team"
      }
    }
  }
}
```

Codex (`config.toml`):

```toml
[mcp_servers.mobile-farm]
command = "node"
args = ["/Users/you/.mobile-farm/mcp.mjs"]
env = { MOBILE_FARM_URL = "https://mobile-farm.example.com", MOBILE_FARM_ORG = "example-team" }
```

**This config holds no secret.** Only a URL and, optionally, a non-secret org
name. The credential lives once, in `~/.mobile-farm/credentials`. That is the
point of the whole PAT flow, and it is why a repository can commit its
`.mcp.json`.

## Choosing an org

`MOBILE_FARM_ORG` is a **name**, not an id, and only a default. Precedence
for any single call:

1. An explicit `org` argument on the tool call
2. `MOBILE_FARM_ORG`
3. Your sole membership, if you belong to exactly one org

If none of those resolve, the call **fails and names the orgs to choose
from**. It never guesses — picking silently would run a flow against another
tenant's device and write artifacts into their job history.

`list_orgs` reports which orgs the credential can act on and which one calls
default to, and why. An agent can use it to explain its own access rather
than being told.

## CI keeps using an org token

Set `MOBILE_FARM_TOKEN` instead of creating a PAT. An org token fixes the org
by definition, so if it is set it wins over any saved credential, and passing
an `org` argument alongside it is an argument error rather than something
silently ignored.

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `MOBILE_FARM_URL` | yes | Farm base URL. Normalised to origin + path — a pasted `?token=…` status URL has its query stripped rather than being concatenated into every request. |
| `MOBILE_FARM_ORG` | no | Default org for PAT use — a **name**, e.g. `example-team`. **Non-secret**, safe to commit. |
| `MOBILE_FARM_TIMEOUT_MS` | no | Per-request HTTP timeout, default `900000` (15 min). Bounds one HTTP call end to end — connection, headers *and* body — not a job. `wait_for_job` has its own budget, and the SSE stream it consumes is deliberately not bounded by this. |
| `MOBILE_FARM_TOKEN` | no | An **org** token. If set it wins over any saved credential, fixes the org, and makes an `org` argument an error. |

## The tools

Seven tools. Every one except `get_device` takes an optional `org` argument.

| Tool | Arguments | Behaviour |
|---|---|---|
| `run_flows` | `apkPath`, `flows[]`, **exactly one** of `e2eDir` or `flowsArchive`, optional `org` | Uploads the APK and flows to `POST /run`, exactly as CI does. Returns a job id immediately — does not block. Passing both or neither of `e2eDir`/`flowsArchive` is an argument error, deliberately not a silent precedence rule. |
| `wait_for_job` | `jobId`, optional `timeoutSeconds` (default 600, clamped 1–1800), optional `org` | Consumes the job's SSE stream. On timeout returns the last known state as a normal result, not an error — a long run that has not finished is information. |
| `get_job` | `jobId`, optional `org` | Full detail: every flow, its verdict, artifact ids. |
| `list_jobs` | optional `limit` (default 50, clamped 1–200), optional `org` | Recent jobs for the org, newest first. |
| `get_artifact` | `artifactId`, optional `org` | png/jpeg inline as images (capped at 5 MB, over which it returns size + URL as text); `.log`/stdout/stderr as tail-truncated text; video never inlined, only a link. Probes with a one-byte ranged request first, so an over-cap image or a recording is never downloaded, and text is fetched only from its tail. |
| `get_device` | none | The registered device pool, live adb state per device, which are enrolled, the farm-wide `artifactBytes` total, and the farm's `runnerVersion`. Devices are farm-wide, so this takes **no** `org` argument — passing one is an argument error. It deliberately does not claim to report which app build is on any given phone; the farm has no way to know. |
| `list_orgs` | none | The orgs this credential can act on, and which one calls default to, and why. |

Results are text by default — a run summary plus artifact ids, including the
tail of a failing step's `maestro.log` (last 100 lines or 8000 characters,
whichever comes first, with a truncation marker). Images come back only when
you ask for a specific artifact.

## Two things worth knowing before you point an agent at this

⚠️ **`get_artifact` returns screenshots of real, logged-in app sessions as
inline image content.** Those images travel to whatever model backend your
harness is configured against, like any other tool result. This is inherent
to handing screenshots to an agent, but worth deciding about deliberately
rather than discovering later.

⚠️ **The device is shared and singular.** A `run_flows` call takes the one
physical phone for the duration of the job. An agent looping on flows will
queue behind — and ahead of — your CI.

## Startup behaviour

The client connects its stdio transport first, then fetches `GET /api/version`
in the background on a fixed 5-second budget of its own. If its baked-in
version differs from the farm's it writes one advisory line to stderr naming
both versions and the re-download command. It never blocks startup, so an
unreachable or slow farm cannot delay the server answering `initialize`.

If the farm was built without a bundle (a from-source dev run that never ran
`build:mcp`), `GET /api/mcp-client` returns `503` with a JSON body saying so.
That is an operational state, not a crash.
