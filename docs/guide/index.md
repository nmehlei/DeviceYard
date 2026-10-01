# DeviceYard — guides

An HTTP service that runs [Maestro](https://maestro.mobile.dev) E2E flows
against a real, USB-attached Android phone. You send it a testing APK and
your `e2e/` directory; it installs, runs each flow in order, and hands back
verdicts plus every screenshot, screen recording, view hierarchy dump and
log Maestro produced.

Several devices can be enrolled at once; jobs are claimed by whichever device
is free, and an admin-configurable cap bounds how many run at the same time.

## Which guide do you want?

| You are… | Start here |
|---|---|
| Running flows from your terminal or CI | [The `deviceyard` CLI](cli.md) |
| Migrating from `maestro cloud` or `dcd cloud` | [The `deviceyard` CLI](cli.md#migrating-from-maestro-cloud-or-dcd-cloud) |
| Wiring a CI pipeline to run flows | [Running flows](running-flows.md) |
| Passing config or credentials into a flow | [Environment variables](environment-variables.md) |
| Looking at screenshots, recordings and logs afterwards | [Artifacts and retention](artifacts-and-retention.md) |
| Pointing a coding agent at the device | [MCP server](mcp.md) |
| Using the web dashboard, or building against its routes | [Dashboard](dashboard.md) |
| Watching a device's screen, or taking control of it, from the dashboard | [Remote control](remote-control.md) |
| Running or deploying the farm itself | [Operating the farm](operating.md) |
| Sending traces, logs and metrics to your own backend | [Observability](observability.md) |
| Looking up one endpoint's exact contract | [API reference](api-reference.md) |

## The five-minute version

```bash
curl -X POST https://mobile-farm.example.com/run \
  -H "Authorization: Bearer $FARM_TOKEN" \
  -F apk=@app-testing.apk \
  -F flowsArchive=@e2e.tar.gz \
  -F flows='["map/map"]'
# -> 202 {"id":"<job-id>","status":"queued"}

curl -H "Authorization: Bearer $FARM_TOKEN" \
  https://mobile-farm.example.com/run/<job-id>
# -> {"id":…,"status":"done","results":[{"flow":"map/map","passed":true,…}]}
```

That is the whole CI contract. Everything else in these guides is detail
around those two calls.

## Two API surfaces, one service

This trips people up, so it is worth stating once up front. The farm serves
two unrelated sets of routes:

- **The CI API** — `POST /run`, `GET /run/:id`, `GET /jobs`, `GET /status`.
  Flat paths, no `/api` prefix, deliberately frozen: DonableApp's pipeline
  depends on these exact response shapes, and they are covered by a contract
  test suite that must never change. This is what [Running flows](running-flows.md)
  documents.
- **The dashboard API** — everything under `/api/*`. Different paths,
  different response shapes, richer detail, free to evolve.

`GET /jobs` (CI) and `GET /api/jobs` (dashboard) are two different routes
that happen to share a word. Do not reach for one expecting the other.

## Notifications

See [Notifications](notifications.md) for SMTP setup, account emails, run
preferences, device alerts, and delivery-history semantics.
