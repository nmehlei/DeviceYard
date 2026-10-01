# The `deviceyard` CLI

A single command that uploads your app, runs your flows on whichever real
device in the farm's pool is free, streams the verdicts back and exits with a
code your pipeline can gate on. It mirrors [`maestro cloud`](https://docs.maestro.dev) and DeviceCloud's
[`dcd cloud`](https://docs.devicecloud.dev/cli-reference/overview), so a team
already using either one changes the binary name and little else.

```bash
deviceyard cloud app-testing.apk e2e/scenarios
```

For the raw HTTP contract underneath it, see the
[API reference](api-reference.md).

## Install

**With npm** — needs Node 20 or newer:

```bash
npm install -g @deviceyard/cli
```

**Without Node** — a standalone binary, nothing else required:

```bash
curl -fsSL https://your-farm.example.com/cli/install.sh | sh
```

The installer resolves the binary for your platform from the public npm
registry and drops it in `~/.deviceyard/bin`. It prints the `PATH` line to add
if that directory is not already on yours. Supported platforms: macOS and
Linux, on arm64 and x64.

**In CI, without installing anything:**

```bash
npx --yes @deviceyard/cli@latest cloud app-testing.apk e2e/scenarios
```

Keeping a binary install current:

```bash
deviceyard upgrade          # binary installs
npm install -g @deviceyard/cli@latest   # npm installs
```

## Authenticate

**Locally**, store a personal access token. Create one in the dashboard under
Account settings, then:

```bash
deviceyard login --url https://your-farm.example.com
# paste the token, then Ctrl-D
#   or:  pbpaste | deviceyard login --url https://your-farm.example.com
```

The token is read from **stdin only**, never from an argument — an argument
lands in your shell history and in `ps` output, where any other user on the
box can read it. It is stored `0600` in `~/.deviceyard/credentials`.

A personal token belongs to a person, not an org, so every command that
touches a job needs `--org <id>`. `deviceyard whoami` lists the ids you have:

```bash
deviceyard whoami
# https://your-farm.example.com  (personal credential)
#   1  donable
#   2  momentum
```

**In CI**, use an org token instead. It fixes its own org, so no `--org` is
needed:

```bash
export DEVICEYARD_URL=https://your-farm.example.com
export DEVICEYARD_API_KEY=...        # an org token from the dashboard
deviceyard cloud app-testing.apk e2e/scenarios
```

Credentials resolve in this order: `--api-key`, then `DEVICEYARD_API_KEY`,
then `~/.deviceyard/credentials`. `MOBILE_FARM_URL` and `MOBILE_FARM_TOKEN`
are still accepted, so a pipeline already set up for the MCP client needs no
edit.

## Your flows directory

This farm resolves a flow at `e2e/scenarios/<name>.yaml`, so your flows must
live in an `e2e/scenarios` tree:

```
your-repo/
  e2e/
    scenarios/
      login.yaml        ->  the flow "login"
      map/filter.yaml   ->  the flow "map/filter"
    shared/             ->  shipped too, so relative references keep working
```

Point the CLI at that tree, at a sub-directory of it, or at a single `.yaml`
file:

```bash
deviceyard cloud app.apk e2e/scenarios
deviceyard cloud app.apk e2e/scenarios/map
deviceyard cloud app.apk e2e/scenarios/login.yaml
```

The CLI walks up to find the `e2e/` root and ships the whole directory, so
files your flows reference from `e2e/shared/` keep resolving exactly as they
do locally. If there is no `e2e/scenarios` above the path you gave, it says so
rather than uploading an archive the farm would reject.

Flows run **in the order the CLI submits them**, which is alphabetical by id.
Only `.yaml` is recognised — a `.yml` file is not a flow here.

## A first run

```bash
deviceyard cloud app-testing.apk e2e/scenarios --org 1
....  login
PASS  login
....  map/filter
FAIL  map/filter

job 1756800000000-a1b2c3: 1/2 passed
  FAIL  map/filter
```

Check what would be submitted without uploading anything:

```bash
deviceyard cloud app-testing.apk e2e/scenarios --dry-run
```

## Commands

| Command | What it does |
|---|---|
| `cloud <app-file> <flows>` | Upload and run, waiting for every verdict |
| `status <job-id>` | Show one job and its steps |
| `list` | Recent jobs, newest first |
| `artifacts <job-id>` | Download a job's screenshots, recordings and logs |
| `login` / `logout` / `whoami` | Manage the stored credential |
| `upgrade` | Update a binary install |

## Flags

### Authentication and target

| Flag | Meaning |
|---|---|
| `--api-key <key>` | Credential to use. Defaults to `DEVICEYARD_API_KEY`, then the stored one |
| `--url <url>` | The farm. Defaults to `DEVICEYARD_URL` |
| `--org <id>` | Which org to act as. Required for a personal access token |

### Choosing flows

| Flag | Meaning |
|---|---|
| `--flows <path>` | The flows path, instead of the positional argument |
| `--exclude-flows <paths>` | Comma-separated flow ids or sub-directories to skip |
| `--include-tags <tags>` | Only run flows carrying one of these tags |
| `--exclude-tags <tags>` | Skip flows carrying one of these tags |

Tag filtering happens **on your machine**, before submission: the CLI already
reads each flow's header to build the job, so it reads `tags:` while it is
there. `--dry-run` shows you exactly which flows and tags it found.

### The run

| Flag | Meaning |
|---|---|
| `--app-file <path>` | The app binary, instead of the positional argument |
| `--env KEY=VALUE` | An environment variable for every flow. Repeat for more |
| `--name <name>` | A label for the run |
| `--async` | Submit and exit `0` immediately, printing only the job id |
| `--dry-run` | Resolve and print everything, upload nothing |

`--env` is validated locally against the farm's own rules — identifier-shaped
keys, no newlines, and a four-character minimum for anything named like a
secret (`PASSWORD`, `TOKEN`, `SECRET`, `API_KEY`) — so a typo fails before a
500 MB upload rather than after it. Values of secret-named variables are
masked in stored logs and artifacts; see
[Environment variables](environment-variables.md).

### Output

| Flag | Meaning |
|---|---|
| `--quiet`, `-q` | Suppress per-step lines; still prints the summary |
| `--json` | Print the result as JSON. Still exits `2` on a flow failure |
| `--json-file` | Write the result as JSON. Exits `0` even on a flow failure |
| `--json-file-name <name>` | Where to write it. Defaults to `<job-id>_deviceyard.json` |
| `--report junit` | Write a JUnit XML report |
| `--junit-path <path>` | Where to write it. Defaults to `./report.xml` |
| `--download-artifacts ALL\|FAILED` | Download artifacts after the run |
| `--artifacts-path <path>` | Directory to download into. Defaults to `./artifacts` |
| `--debug` | Verbose diagnostics |

Use `--json` when you want the exit code to gate the build, and `--json-file`
when your pipeline will read the result itself and decide.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Every flow passed — or `--async` submitted, or `--json-file` wrote its file |
| `1` | A CLI or infrastructure problem: bad arguments, unreachable farm, bad credential, empty device pool |
| `2` | A flow failed |

The `1` / `2` split is load-bearing. A job that fails before any flow runs —
no device enrolled, the install failed, the archive would not extract — exits
`1`, so a pipeline that retries on `2` does not retry an infrastructure
outage as though a test had flaked.

## Migrating from `maestro cloud` or `dcd cloud`

Most flags are the same. These behave identically:

| `maestro cloud` / `dcd cloud` | `deviceyard cloud` |
|---|---|
| `--api-key` | `--api-key`, or `DEVICEYARD_API_KEY` |
| `--app-file`, `--flows` | Same |
| `--exclude-flows` | Same |
| `--include-tags`, `--exclude-tags` | Same, applied client-side before submission |
| `--env KEY=VALUE` | Same |
| `--name` | Same |
| `--async` | Same |
| `--quiet` / `-q` | Same |
| `--json`, `--json-file`, `--json-file-name` | Same |
| `--dry-run` | Same |
| `--debug` | Same |
| `--report junit`, `--junit-path` | Same |

One flag means something different:

| Flag | Difference |
|---|---|
| `--artifacts-path` | Names a **directory**, not `dcd`'s `artifacts.zip`. Files land at `<path>/<flow name>/<artifact>` |

Everything else `dcd cloud` accepts is **recognised and rejected with a
reason**, never as an unknown option — so a migrating pipeline gets a
diagnosis rather than a parser error:

| `dcd cloud` flag | `deviceyard` | Why |
|---|---|---|
| `--ios-device` | — | This farm's pool is Android-only; iOS is not available |
| `--ios-version` | — | This farm's pool is Android-only; iOS is not available |
| `--android-device` | — | The scheduler picks whichever enrolled device is free - a job cannot pick a model |
| `--android-api-level` | — | A job's API level is whatever the device it lands on runs, and that pick is the scheduler's, not the caller's |
| `--retry` | — | Retries are not supported; re-run the job, or handle the retry in your pipeline |
| `--maestro-version` | — | The farm pins one Maestro version - GET /api/version reports which |
| `--app-binary-id` | — | Uploaded binaries are not retained for reuse; every run uploads its app file |
| `--app-url` | — | The app must be uploaded from disk; the farm does not fetch app binaries over the network |
| `--google-play` | — | Device capabilities are fixed by the attached hardware |
| `--orientation` | — | Orientation is not controllable per run |
| `--device-locale` | — | Device locale is not controllable per run |
| `--runner-type` | — | This farm has one runner |
| `--disable-animations` | — | Animation scales are a property of the device a job lands on, not of a run |
| `--show-crosshairs` | — | Crosshair overlays are not supported |
| `--android-no-snapshot` | — | The farm runs physical hardware, not snapshot-booted emulators |
| `--maestro-chrome-onboarding` | — | Chrome onboarding control is not supported |
| `--ignore-sha-check` | — | Every run uploads its app file, so there is no SHA cache to bypass |
| `--config` | — | Workspace config files are not read; pass the flags explicitly |
| `--metadata` | — | Arbitrary run metadata is not stored; use --name |
| `--branch` | — | Git metadata is not stored against a run |
| `--commit-sha` | — | Git metadata is not stored against a run |
| `--repo-name` | — | Git metadata is not stored against a run |
| `--pr-number` | — | Git metadata is not stored against a run |
| `--pr-url` | — | Git metadata is not stored against a run |

If you need one of these, say so — several are farm capabilities rather than
CLI gaps, and the ones worth building are tracked in
[open issues](../open_issues.md).

## Troubleshooting

**`the platform binary @deviceyard/cli-... is not installed`** — npm skipped
the optional dependency for your platform. Reinstall with
`npm install -g @deviceyard/cli --include=optional`.

**`this credential is a personal access token ... name the org with --org`** —
you are using a PAT. Run `deviceyard whoami` for your org ids, or use an org
token in CI.

**`could not find an e2e/scenarios directory above ...`** — see
[Your flows directory](#your-flows-directory).

**`no device is enrolled - add a device and enable it from the Devices page
first`** — the pool is empty; no device is enrolled at all. Add one and
enable it on the Devices page; see [Operating the farm](operating.md). This
is never returned just because every enrolled device happens to be busy —
the job queues instead and runs once one frees up.
