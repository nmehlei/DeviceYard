# Dashboard

A web UI for watching runs, reading artifacts, managing org membership and
tokens, and (for admins) managing users, orgs and retention. It is a static
Next.js export served by the farm itself, backed by the `/api/*` routes.

## Signing in

Log in at `/login` with a username and password. A successful login sets an
httpOnly, `Secure`, `SameSite=Lax` session cookie, so the browser never holds
a credential in JavaScript or in a URL.

Sessions are the only credential that can manage tokens. A PAT presented to
`POST /api/me/tokens` is rejected deliberately: a token that could mint
tokens could mint its own successor and outlive its own revocation.

## Pages

| Path | What it is |
|---|---|
| `/history` | Job list for the selected org |
| `/jobs/<id>` | One job: every step, its verdict, its artifacts, live |
| `/devices` | Registered devices (a pool), live adb state, enable / disable / remove / reboot / screenshot |
| `/orgs/<id>` | Org membership and org tokens |
| `/admin` | Users, orgs, retention thresholds, upload cap, scheduler concurrency cap — admin only |
| `/about` | Farm version and Maestro version |

There is also `GET /status`, a small self-refreshing HTML page listing the
caller's jobs. It predates the dashboard and is handy to open directly with
`?token=<token>` when you have a token but no login.

## Choosing an org

A session can belong to several orgs. Which org a request is for comes from
an `X-Org-Id` header, falling back to an `?orgId=` query parameter — the
fallback exists because `EventSource` and `<img>`/`<a>` URLs cannot set
custom headers at all.

`GET /api/me/orgs` is the discovery call: it accepts a session cookie *or* a
PAT, with no org named, because it is how a client finds out which org to
ask for.

## Watching a job live

`GET /api/jobs/:id/events` is a Server-Sent Events stream carrying the same
payload as `GET /api/jobs/:id`. It sends the current state immediately, then
a new event as each step lands, and closes once the job reaches `done` or
`failed`.

Sending full state first, increments after, means a client joining
mid-job never has to reconstruct what it missed.

```js
const es = new EventSource(`/api/jobs/${id}/events?orgId=${orgId}`);
es.onmessage = (e) => render(JSON.parse(e.data));
```

## Tokens

Two kinds, managed in two places:

| | Org token | Personal access token |
|---|---|---|
| Belongs to | An org | A person |
| Scope | That one org | Every org that person belongs to |
| Managed at | `/orgs/<id>` | Account settings |
| Routes | `/api/orgs/:id/tokens` | `/api/me/tokens` |
| Needs `X-Org-Id`? | No — the org is implied | Yes, on every call |
| Intended for | CI pipelines | Humans and coding agents |

Both are stored encrypted at rest and returned in plaintext to an authorised
caller, with `Cache-Control: no-store` so a browser or shared cache never
holds onto the response.

A PAT cannot reach `/api/admin/*`, cannot perform `/api/orgs/*` writes, and
cannot manage tokens.

## Permissions in one paragraph

Org routes require a logged-in member of that org; a non-member gets `404`,
not `403`, so they get no confirmation the org even exists. Admins bypass the
membership check for any org that exists. An archived org returns `404` for
everyone including its members — except admins, who can still reach it for
cleanup. Removing an org's last member is refused with `409`: it would be a
dead end nobody could recover from through the ordinary routes.

## Devices

Device management lives at `/devices` and is farm-wide, not org-scoped.
Devices are a **pool**: any number can be enrolled at once, and jobs run
concurrently across whichever are enrolled and free — there is no single
"the active device" anymore.

One bounded (5-second) `adb devices` call answers for every registered row at
once, so the list stays cheap as devices are added. A device that is not
currently attached reports `state: "offline"` and is never removed from the
list — its adb serial is its permanent identity, reused if the same physical
phone reconnects later.

Each card has **Enable** / **Disable** rather than a single Activate button.
Enabling adds a free device to the pool immediately — safe at any time.
Disabling drains it: it finishes whatever job it currently holds but is never
claimed for a new one after that, without interrupting the running flow.
Once a device is disabled and idle, its card also offers **Remove**, which
deletes the row entirely (`409` if it's still enrolled, or still running a
job). Reboot is per-device and independent of the others — it only refuses
(`409`) if *that* device is currently running a job; a busy device never
blocks rebooting an idle one.

The job list and a job's detail page now show **which device** ran it
(`job.deviceId`), set the moment the scheduler claims the job — blank while
still `queued`.

`GET /api/devices/:id/screenshot` streams one live PNG frame straight
through, never written to disk and never added to the artifacts table.

**Setup warnings.** A card shows an amber notice for each required device
setting that is wrong (see operating.md, "Required device settings"), and
the summary row adds a **Needs setup** count. Admins get a **Fix** button that
applies the setting over adb and reads it back; everyone else is told to ask
an admin. A device that cannot be read (offline, unauthorized) shows no
warning rather than a guess.

## Full route contracts

See the [API reference](api-reference.md).

## Notifications and account emails

The account menu's **Notifications** page provides email verification,
per-organisation run preferences, admin device alerts, and sample email
previews. **Admin → Notifications** provides SMTP readiness, test email, and
delivery history. Organisation members can invite people by email, and the
sign-in page provides **Forgot password?**. See [Notifications](notifications.md).
