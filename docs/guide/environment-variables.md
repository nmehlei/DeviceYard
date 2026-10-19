# Environment variables in flows

Maestro flows can read variables supplied at invocation time — a launcher
choice, a test account, an API base URL. Locally you pass them with
`maestro test -e KEY=VALUE`. Through the farm, you pass an `env` object on
`POST /run` and the farm forwards each pair as `-e KEY=VALUE` to every flow
in the job.

```bash
curl -X POST "$FARM_URL/run" \
  -H "Authorization: Bearer $FARM_TOKEN" \
  -F apk=@app-testing.apk \
  -F flowsArchive=@e2e.tar.gz \
  -F flows='["login/signin"]' \
  -F env='{"E2E_LAUNCHER":"samsung","E2E_TEST_USER":"momentum-ci"}'
```

In the flow:

```yaml
appId: com.example.app
---
- launchApp
- tapOn: "Sign in"
- inputText: ${E2E_TEST_USER}
```

## The wire format

`env` is a **JSON-encoded flat object of string to string**, sent as an
ordinary multipart form field alongside `flows`.

It is entirely optional, and absent means absent: a request with no `env`
field produces byte-for-byte the same Maestro invocation it did before this
feature existed. If you are not using it, nothing about your pipeline
changes.

Validation is strict — the farm rejects rather than escapes, so a value can
never be reinterpreted somewhere downstream. Every failure is a `400` naming
the offending key:

| Rule | Rejected example |
|---|---|
| Must parse as JSON and be a flat object of string values | `env='["A","B"]'` |
| Keys must match `^[A-Za-z_][A-Za-z0-9_]*$` | `"2FA"`, `"my-key"`, `"a.b"` |
| Values must not contain a newline, carriage return or NUL | a pasted multi-line PEM |
| A secret-named key's value must be at least 4 characters | `{"API_TOKEN":"ab"}` |

That last rule is not arbitrary — a two-character secret would make the
masking below replace every occurrence of those two characters throughout
every stored log. Rejecting is safer than producing shredded artifacts.

## Ordering and duplicates

Keys are **sorted** before the `-e` flags are built, so the same request
always produces the same command line. A JSON object cannot hold a duplicate
key, so where `maestro test` would accept a repeated `-e FOO=` and take the
last one, here you simply get one entry.

This matters because a future farm CLI is meant to be a drop-in for
`maestro`: the mapping between the two has to be lossless and written down
rather than assumed.

## Secrets

⚠️ **Read this before sending a password through `env`.**

`env` values reach Maestro in full — that is what makes the feature useful.
But the farm also persists your flow's stdout/stderr and everything Maestro
writes to its debug-output directory as artifacts, and keeps them
indefinitely by default. So a credential passed in needs to not appear in
what gets stored, and the farm has one mechanism for that.

### Masking is by naming convention

A key whose name contains any of these, case-insensitively, is treated as
secret:

```
PASSWORD    TOKEN    SECRET    API_KEY    APIKEY
```

Its value is replaced with `***REDACTED***` everywhere the farm stores text:
artifact files, stdout/stderr previews, job history, error messages.

This follows [Device Cloud's convention](https://docs.devicecloud.dev/configuration/environment-variables.md),
plus `APIKEY` without the underscore — Device Cloud's published list does not
cover that spelling, and an unmasked credential is worse than a small
divergence from someone else's convention.

**A key without one of those markers is stored and forwarded verbatim.** Name
your variables accordingly. `E2E_TEST_PASSWORD` is masked; `E2E_TEST_PW` is
not.

### What masking actually guarantees

It is literal substring replacement, over three forms of the value: the raw
string, its JSON-escaped form, and its XML entity-escaped form. Those three
cover how Maestro writes values into `commands-*.json` and into hierarchy
dumps.

What that gets you: **the value as you supplied it will not appear in stored
text.**

What it does not get you: protection against a *transformation*. If a flow
base64-encodes the value, URL-encodes it, truncates it, or prints a hash of
it, that derivative is not matched and will be stored.

Two more limits worth stating plainly:

- **Values reach Maestro unmasked, always.** Masking governs only what the
  farm stores. They are passed as command-line arguments, which means they
  are visible in the farm host's process list (`ps`) for the duration of the
  invocation.
- **A flow that prints something sensitive the farm never saw is not
  covered.** Masking only knows the values you sent it.

### Why this exists at all

Maestro has an open, unfixed defect —
[mobile-dev-inc/Maestro#2512](https://github.com/mobile-dev-inc/Maestro/issues/2512)
— where every `-e` value is written verbatim into `commands-*.json` inside
its `--debug-output` directory. The farm collects that directory wholesale as
artifacts, which are then readable through the dashboard and by a coding
agent through the MCP tools.

So without masking, passing a password to a flow would publish it. Most of
this feature is the containment, not the passthrough. If that upstream issue
is ever fixed, some of the above may stop being necessary — check it before
relying on any of this staying true.

## Worked example: a password from your secret store

Say Momentum's flows need a real test account.

**1. Name the variables so masking catches them.** `E2E_TEST_USER` is a
username — not secret, and useful to see in logs. `E2E_TEST_PASSWORD`
contains `PASSWORD`, so it is masked.

**2. Keep the value out of your pipeline logs too.** The farm masks its own
stored output; it cannot do anything about your CI printing the value before
the request is even made. Build the JSON with `jq` rather than string
interpolation, and never `set -x` around it:

```bash
ENV_JSON=$(jq -nc \
  --arg user "$E2E_TEST_USER" \
  --arg pass "$E2E_TEST_PASSWORD" \
  --arg launcher samsung \
  '{E2E_TEST_USER:$user, E2E_TEST_PASSWORD:$pass, E2E_LAUNCHER:$launcher}')

curl -sf -X POST "$FARM_URL/run" \
  -H "Authorization: Bearer $FARM_TOKEN" \
  -F apk=@app-testing.apk \
  -F flowsArchive=@e2e.tar.gz \
  -F flows='["login/signin"]' \
  -F env="$ENV_JSON"
```

`jq -n` also handles quoting and escaping correctly for a password
containing `"`, `\` or `$`, which hand-built JSON reliably gets wrong.

**3. Check the artifacts once.** After the first run, open the job in the
dashboard and look at the failing step's `maestro.log` and the
`commands-*.json` artifacts. You should see `***REDACTED***` where the
password would be. If you see the value, the key name did not match the
convention — rename it.

**4. Use a dedicated test account.** Masking reduces exposure; it does not
make a production credential safe to hand to a test runner on a shared
device.

## Where the value is stored

The job record keeps the env you sent, with secret values already replaced,
so job history shows which variables a run used without holding the
credentials.

Where you can read it back is uneven, and worth knowing:

- `GET /run/:id` and `GET /jobs` (the CI API) **do not** include it. Those
  response shapes are frozen for CI compatibility and were not changed.
- `GET /api/jobs/:id` and `GET /api/jobs` (the dashboard API) return the
  whole job row, so `envJson` is present there today — as a JSON string, not
  a parsed object. Treat this as an implementation detail rather than a
  stable API field; avoid building integrations against it.

## What is deliberately not supported

The farm never merges your variables into the Maestro child process's
environment. They are passed as `-e` flags and nothing else. This is
deliberate: the farm's own process holds its session secret and token
encryption key, and a flow that inherited the process environment would be
one step from reading them.
