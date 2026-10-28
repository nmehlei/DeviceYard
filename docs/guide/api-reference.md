# API reference

Exhaustive per-endpoint contracts. For how to actually use them, start with
[Running flows](running-flows.md) or the [dashboard guide](dashboard.md).

Every deployed instance publishes its machine-readable OpenAPI 3.1 contract
at `GET /openapi.json`. The document is intentionally available without
authentication so clients and development tools can discover authentication
requirements before they are configured. Its `info.version` identifies the
version deployed at that origin. A self-hosted interactive viewer is available
at `/api-docs`; it loads the same JSON document.

Timestamps are **epoch milliseconds as JSON numbers**, everywhere.

## Authentication

Three credential types. Requests are checked in this order, and an explicit
credential always wins over an ambient cookie.

| Credential | Presented as | Names its org how? |
|---|---|---|
| Org token | `Authorization: Bearer <token>`, or `?token=` | Implicitly — the token is bound to one org |
| Personal access token | `Authorization: Bearer <token>` | `X-Org-Id: <numeric id>`, or `?orgId=` |
| Session cookie | Set by `POST /api/session` | `X-Org-Id: <numeric id>`, or `?orgId=` |

The `?token=` and `?orgId=` query fallbacks exist because `EventSource`,
`<img>` and `<a>` cannot set custom headers.

A bearer token never carries a person's identity. If an org token is
presented alongside a stale admin cookie, the cookie identity is stripped —
otherwise a CI token beside an admin session would look like an admin
request.

### Auth error responses

| Status | Body | When |
|---|---|---|
| `401` | `{"error":"missing bearer token"}` | No credential of any kind |
| `403` | `{"error":"invalid token"}` | Token not found or revoked |
| `403` | `{"error":"this token belongs to a person, not an org - name the org with the X-Org-Id header"}` | PAT with no (or non-integer) `X-Org-Id` |
| `403` | `{"error":"not a member of that org"}` | PAT naming an org you are not in, or an archived one |
| `403` | `{"error":"admin access required"}` | Non-admin on `/api/admin/*` |
| `401` | `{"error":"login required"}` | `/api/orgs/*` or `/api/me/orgs` with no identity |
| `401` | `{"error":"this needs a logged-in session, not a token"}` | PAT on a token-management route |

---

# CI API

Flat paths, no `/api` prefix. **These response shapes are frozen** — a
contract test suite pins them, because existing CI integrations depend on them.
Nothing here will change shape.

## `POST /run`

`multipart/form-data`. Queues flows to run against whichever enrolled device
is free. Devices are a **pool** — many can be enrolled at once, jobs run
concurrently across them (subject to `maxConcurrentJobs`, see
[Operating the farm](operating.md)), and a job is bound to a device only when
the scheduler claims it, never at submit time.

**Parts**

| Part | Type | Required | Meaning |
|---|---|---|---|
| `apk` | file | yes | The built testing APK |
| `flowsArchive` | file | yes | `.tar.gz` of the `e2e/` directory |
| `flows` | field | yes | JSON array of flow identifiers, non-empty, all strings |
| `env` | field | no | JSON object of `string → string`, forwarded as `-e KEY=VALUE` |
| `isolation` | field | no | `disabled` (default), `per-job` or `per-flow`. Anything other than `disabled` needs Pro. See [isolation](isolation.md) |

**`202 Accepted`** — `{ "id": string, "status": "queued" }`. When `isolation` is `per-flow`, the body also carries `"warnings": string[]` describing the cost of per-flow isolation. Without `isolation`, the body is unchanged.

**Errors**

| Status | Body | Cause |
|---|---|---|
| `400` | `{"error":"apk file is required"}` | Missing `apk` |
| `400` | `{"error":"flowsArchive file is required"}` | Missing `flowsArchive` |
| `400` | `{"error":"flows must be a non-empty JSON array of strings"}` | Malformed `flows` |
| `400` | `{"error":"env must be a JSON-encoded object"}` | `env` not a string field |
| `400` | `{"error":"env is not valid JSON"}` | `env` unparseable |
| `400` | `{"error":"env must be a JSON object of string values"}` | `env` is an array, null, or scalar |
| `400` | ``{"error":"env key \"…\" is not a valid identifier"}`` | Key fails `^[A-Za-z_][A-Za-z0-9_]*$` |
| `400` | `{"error":"env value for KEY must be a string"}` | Non-string value |
| `400` | `{"error":"env value for KEY must not contain a newline or NUL"}` | Value contains `\n`, `\r` or NUL |
| `400` | `{"error":"env value for KEY is too short to mask safely (minimum 4 characters)"}` | Secret-named key with a value under 4 characters |
| `413` | `{"error":"apk exceeds the upload limit of 512 MB - an admin can change it on the Admin page"}` | A file above the configured cap |
| `400` | `{"error":"unexpected file field \"…\""}` | A file part other than `apk` or `flowsArchive` |
| `400` | `{"error":"upload rejected: LIMIT_FILE_COUNT"}` | More than two files, or an implausible number of parts or fields |
| `400` | `{"error":"isolation must be one of disabled, per-job, per-flow"}` | `isolation` is not one of the three modes |
| `403` | `{"error":"Work-profile isolation requires an active Pro license","code":"PRO_ISOLATION_REQUIRED"}` | `isolation` is not `disabled` and there is no active Pro isolation |
| `503` | `{"error":"no device is enrolled - add a device and enable it from the Devices page first"}` | The pool is empty — no device enrolled at all. **Never** returned just because every enrolled device is currently busy; a job queues instead |

Every `400` deletes the uploaded files before responding — a rejected request
never leaves uploads on disk. The same holds on the `413` path.

**Upload cap.** Each file is capped at an admin-configurable limit, **512 MB
by default**, editable under Admin → Uploads. A saved change applies to the
next request; no restart. An admin can clear the limit entirely, restoring
unbounded uploads. See [Operating the farm](operating.md).

## `GET /run/:id`

**`200`**

```jsonc
{
  "id": "string",
  "org": "string",
  "flows": ["string"],              // flow steps, in order
  "status": "queued|running|done|failed",
  "results": [
    { "flow": "string", "passed": true, "stdout": "string", "stderr": "string" }
  ],
  "error": "string",                // present only when status is "failed"
  "createdAt": 1756800000000
}
```

`results` holds one entry per flow that reached a verdict. If a **setup**
stage failed instead, `results` holds exactly one pseudo-entry named
`<device>`, `<install>` or `<extract>`, with `passed: false`.

This shape does **not** carry `deviceId`, even though the pool means a job
now runs on one of several devices — the frozen CI contract fixes this exact
key set, so which device ran a job is a dashboard-API detail (`GET
/api/jobs/:id`'s `job.deviceId`), not a CI one.

**`404`** — `{"error":"job not found"}`. Also returned for a job owned by a
different org: existence is never confirmed across org boundaries.

## `GET /jobs`

**`200`** — a JSON **array** of the same objects as `GET /run/:id`, newest
first, capped at **200**. The cap is a response limit, not retention.

## `GET /status`

**`200`** — a small self-refreshing HTML page listing the caller's jobs.
`Cache-Control: no-store`, `Vary: Cookie`.

---

# Dashboard API

Everything under `/api/*`. Free to evolve; not covered by the frozen contract
suite.

## Session

Not behind the org gate — these routes do their own checks, because login
must be reachable by someone who is not authenticated yet.

### `POST /api/session`
Body `{ username, password }`.
**`200`** — `{ user: { id, username, email, isAdmin }, orgs: [...] }`, plus a
`Set-Cookie` with an httpOnly, `Secure`, `SameSite=Lax` session cookie.
**`400`** missing fields. **`403`** `{"error":"invalid username or password"}`
— returned identically for an unknown username, a wrong password, and a
deactivated account, so none can be distinguished.

### `GET /api/session`
**`200`** — same shape as above. **`401`** `{"error":"not logged in"}`.

### `PATCH /api/session/password`
Body `{ currentPassword, newPassword }`. Self-service; proves the caller
still is who the session says, so an unattended session cannot lock the owner
out.
**`200`** `{ ok: true }`. **`400`** missing fields or too-short new password.
**`403`** `{"error":"current password is incorrect"}`. **`401`** not logged in.

### `DELETE /api/session`
**`204`**, clearing the cookie.

## Identity and personal tokens

### `GET /api/me/orgs`
Accepts a **session or a PAT**, with no org named — this is the discovery
call.
**`200`** — `{ orgs: [{ id, name }] }`. **`401`** `{"error":"login required"}`.

### `GET /api/me/tokens`
**Session only.** **`200`** — `{ tokens: [{ id, userId, label, value, createdAt, lastUsedAt }] }`,
`value` in plaintext, `Cache-Control: no-store`.

### `POST /api/me/tokens`
**Session only.** Body `{ label }`.
**`201`** — `{ token: { … } }`, the new token in plaintext. **`400`**
`{"error":"label is required"}`.

### `DELETE /api/me/tokens/:tokenId`
**Session only.** **`204`**.

> A PAT is rejected on the three token routes above by design: a token that
> could mint tokens could mint its own successor and outlive its revocation.

## Orgs

All require a logged-in **member** of `:id`. Admins bypass the membership
check for any existing org. A non-member gets `404`, not `403` — no
confirmation the org exists. An archived org is `404` for everyone but
admins.

| Route | Success | Notes |
|---|---|---|
| `GET /api/orgs/:id/members` | `200` `{ members: [...] }` | |
| `POST /api/orgs/:id/members` | `201` `{ ok: true }` | Body `{ userId: number }`. `400` if missing, `404` `{"error":"unknown user"}` |
| `DELETE /api/orgs/:id/members/:userId` | `204` | `409` `{"error":"cannot remove the last member of an org"}` |
| `GET /api/orgs/:id/tokens` | `200` `{ tokens: [...] }` | Plaintext values, `Cache-Control: no-store` |
| `POST /api/orgs/:id/tokens` | `201` `{ token: {...} }` | Body `{ label }`; `400` if missing |
| `DELETE /api/orgs/:id/tokens/:tokenId` | `204` | |

## Admin

All require `req.isAdmin`; a bearer-token request never sets it, so CI
credentials are rejected here too. All return `403`
`{"error":"admin access required"}` otherwise.

| Route | Success | Notes |
|---|---|---|
| `GET /api/admin/orgs` | `200` `{ orgs: [...] }` | |
| `POST /api/admin/orgs` | `201` `{ org }` | Body `{ name, initialMemberUserIds? }`. An absent **or empty** member list falls back to the creating admin — a zero-member org would be unreachable forever. `409` on duplicate name |
| `PATCH /api/admin/orgs/:id` | `200` `{ org }` | Body `{ name }`. `404` unknown org |
| `DELETE /api/admin/orgs/:id` | `204` | Archives, does not delete |
| `GET /api/admin/users` | `200` `{ users: [...] }` | |
| `POST /api/admin/users` | `201` `{ user }` | Body `{ username, email, password, isAdmin? }`. `409` on duplicate username |
| `PATCH /api/admin/users/:id` | `200` `{ user }` | Body `{ isAdmin?, password? }`. A too-short password `400`s before any change, so a `200` always means the reset happened |
| `DELETE /api/admin/users/:id` | `204` | Deactivates, does not delete |
| `GET /api/admin/retention` | `200` | `{ maxAgeDays, maxTotalBytes, maxJobs, totalArtifactBytes }` |
| `PUT /api/admin/retention` | `200` | Same shape. Each threshold is a non-negative integer or `null` (disabled); anything else `400`s |
| `GET /api/admin/upload` | `200` | `{ maxUploadBytes, effectiveMaxUploadBytes, defaultMaxUploadBytes }` — stored value, value enforced right now, and the built-in default |
| `PUT /api/admin/upload` | `200` | Same shape. Body `{ maxUploadBytes }`: a **positive** integer of bytes, or `null` for no limit. `0`, negatives, non-integers and an **absent key** all `400` — `0` would mean "reject every upload", and an omitted key must not read as "unlimited" |
| `GET /api/admin/scheduler` | `200` | `{ maxConcurrentJobs }` — `null` means no cap |
| `PUT /api/admin/scheduler` | `200` | Same shape. Body `{ maxConcurrentJobs }`: a **positive** integer, or `null` for no cap. An **absent key** `400`s — see [Operating the farm](operating.md) for when to lower it |

## Jobs

### `GET /api/jobs?limit=<n>`
**`200`** — `{ jobs: [...] }`, newest first. Each job carries the row fields
plus a cheap progress summary: `flowCount`, `passed`, `failed`, `running`.
`limit` defaults to `50`, clamped to `1–200` at both ends.

### `GET /api/jobs/:id`
**`200`** — `{ job, steps }`, where each step includes its `artifacts` array.

```jsonc
{
  // envJson: JSON string of the env this job ran with, secret values already
  // masked — or null if none was sent. This is an implementation detail,
  // not a stable integration contract.
  // deviceId: the enrolled device this job ran (or is running) on, set the
  // moment the scheduler claims it - null while still queued.
  "job":  { "id", "org", "status", "error", "createdAt", "startedAt", "finishedAt", "envJson", "deviceId" },
  "steps": [{
    "id": 42, "jobId": "…", "ordinal": 0,
    "kind": "setup|flow",
    "name": "map/filter",
    "status": "queued|running|passed|failed|skipped",
    "exitCode": 0, "startedAt": …, "finishedAt": …,
    "resolvedPath": "…", "artifactDir": "…",
    "warnings": ["…"],
    "stdoutPreview": "…", "stderrPreview": "…",
    "artifacts": [{ "id": 7, "flowRunId": 42, "kind": "screenshot", "relPath": "…", "bytes": 1234, "createdAt": … }]
  }]
}
```

**`404`** — `{"error":"job not found"}`, including for another org's job.

### `GET /api/jobs/:id/events`
Server-Sent Events, `text/event-stream`. Emits the full `GET /api/jobs/:id`
payload immediately, then again on every step landing, and **closes the
stream** once the job reaches `done` or `failed`.
**`404`** if the job is not yours.

## Files

### `GET /api/flow-runs/:id/log?stream=stdout|stderr`
`:id` is a **step** id. `stream` defaults to `stdout`.
**`200`** `text/plain; charset=utf-8`. **`404`** `{"error":"log not found"}`.

### `GET /api/artifacts/:id`
**`200`** raw bytes, `Content-Type` from the file extension (`.png`, `.jpg`,
`.jpeg`, `.mp4`, `.webm`, `.json`, `.xml`, `.log`; otherwise
`application/octet-stream`).

Supports HTTP Range: `Accept-Ranges: bytes` always, `206 Partial Content`
with `Content-Range` for a valid `Range` header, `416` with
`Content-Range: bytes */<size>` for an unsatisfiable one. A malformed `Range`
falls back to a normal `200` rather than erroring.

**`404`** `{"error":"artifact not found"}` — unknown id, another org's
artifact, or a row whose file is gone.

Ownership is derived from the foreign-key chain (artifact → step → job →
org), never from parsing the stored path.

Both file routes send `Cache-Control: no-store`, `Vary: Cookie` and
`X-Content-Type-Options: nosniff`: these responses can carry screenshots of a
real logged-in app session.

## Devices

Farm-wide, not org-scoped, but still behind the org gate. Devices are a
**pool**: any number can be registered, and any number of *enrolled*
(`isActive: true`) devices can hold a running job at the same time — there is
no single "the active device" anymore. `isActive` marks pool membership, not
which one is currently in use.

### `GET /api/devices`
**`200`** — `{ devices: [{ id, label, model, isActive, state, resetPolicy, setupChecks: [{ id, title, detail, ok }] }], runnerVersion, artifactBytes }`.

`setupChecks` has one entry per required device setting; `ok` is `null` when
it could not be read (device not `device`, or the read failed), so only
`false` is a warning. The model and every check are read in one bounded
`adb shell` call per online device.

`state` comes from a single bounded (5s) `adb devices` call answering for
every row at once. A device not currently attached reports `"offline"` and is
never removed. `artifactBytes` is **farm-wide** — the live running total
across every device, at the top level of the response, not per device.
**`502`** `{"error":"device status unavailable"}` if adb fails.

### `POST /api/devices`
Body `{ id, label? }`, where `id` is the adb serial.
**`201`** — `{ device, setupInstructions: [...] }`. Performs no adb calls.
**`400`** missing id. **`409`** already registered.

### `POST /api/devices/:id/enable`
Adds the device to the pool. **`200`** — `{ device }`. Idempotent:
already-enabled returns `200` unchanged. **`404`** `{"error":"unknown
device"}`. No busy-job guard — enabling a free device disrupts nothing.

### `POST /api/devices/:id/disable`
Drains the device: it finishes any job it currently holds but is never
claimed again after that. Does **not** interrupt a running flow. **`200`** —
`{ device }`. Idempotent. **`404`** unknown device.

### `POST /api/devices/:id/activate`
**Deprecated alias for `enable`**, kept only so a dashboard tab open from
before this deploy keeps working. Same response shape as `enable`. Prefer
`enable`/`disable` in new code.

### `DELETE /api/devices/:id`
Removes a device permanently — the "no way to remove a device" gap from
earlier cycles is closed. **`204`**. **`404`** unknown device. **`409`**
`{"error":"device is still enrolled - disable it first"}` if `isActive`.
**`409`** `{"error":"a job is still running on this device - wait for it to
finish"}` if it currently holds a running job.

### `POST /api/devices/:id/reboot`
**`202`** — `{ ok: true }`. **`404`** unknown device. **`409`** if *this*
device currently holds a running job — per-device, not farm-wide, so a busy
device never blocks rebooting an idle one. **`502`** if `adb reboot` fails.

### `POST /api/devices/:id/setup-checks/:checkId/fix`
Admin only. Applies that check's setting over adb, then reads it back.
**`200`** — `{ check: { id, title, detail, ok: true } }`, recorded as a
`setup_fix` device event. **`403`** not an admin. **`404`** unknown device or
check. **`409`** device not connected and authorized. **`502`** the write
failed, or the read-back did not show the new value (`setting did not take
effect (read back: ...)`) - nothing is recorded.

### `GET /api/devices/:id/screenshot`
**`200`** `image/png` — one live frame, streamed straight through, never
written to disk or added to the artifacts table. **`404`** unknown device.
**`502`** on capture failure.

### `GET /api/devices/:id/events?limit=<n>`
**`200`** — `{ events: [{ id, deviceId, kind, detail, createdAt }] }`, newest
first. `kind` is one of `added`, `activated`, `state_change`, `reboot`,
`screenshot`. `limit` defaults to `30`, clamped `1–100`.

### `GET /api/version`
**`200`** — `{ version, maestroVersion }`.

## MCP client bundle

### `GET /api/mcp-client`
**`200`** — the bundled client as `text/javascript`,
`Content-Disposition: attachment; filename="mcp.mjs"`.
**`503`** `{"error":"the MCP client bundle is not available in this build"}`
if this build was not packaged with one.
