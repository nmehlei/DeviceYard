<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="dashboard/public/brand/deviceyard-mark-dark.svg">
    <img src="dashboard/public/brand/deviceyard-mark.svg" alt="DeviceYard" width="160" height="160">
  </picture>
</p>

<h1 align="center">DeviceYard</h1>
<p align="center"><strong>Real devices. Release confidence. Your infrastructure.</strong></p>
<p align="center">Self-hosted Android testing with Maestro, a web dashboard, CLI, HTTP API, and MCP.</p>
<p align="center">
  <a href="https://deviceyard.codebakery.net">Website</a> ·
  <a href="docs/guide/getting-started.md">Get started</a> ·
  <a href="docs/guide/index.md">Documentation</a> ·
  <a href="https://deviceyard.codebakery.net/pricing/">Pro</a>
</p>

Turn the Android hardware you already own into a repeatable release check.
Send an APK and your Maestro flows to DeviceYard, then inspect the result with
screenshots, recordings, hierarchy dumps, and logs in one place. Your devices,
app binaries, and test results stay on infrastructure you control.

## Why DeviceYard?

- **Real-device feedback:** install your APK and run Maestro flows on USB-connected Android hardware.
- **Evidence for failures:** inspect per-flow results, screenshots, recordings, hierarchy dumps, and logs.
- **Fits your pipeline:** submit from the CLI or HTTP API, export JUnit, and download artifacts. Distinct exit codes separate test failures from runner errors.
- **A shared dashboard:** manage devices, organisations, access tokens, and job history; view and control a device remotely.
- **Tools for coding agents:** use MCP to submit tests and inspect results.
- **Operate on your terms:** drain jobs with maintenance mode and export telemetry to your own OpenTelemetry backend.

## Community and Pro

This repository contains **DeviceYard Community**, licensed under AGPL-3.0-only.
The core testing workflow is available without a paid subscription.

| Capability | Community | Pro |
| --- | --- | --- |
| Maestro runs, results, and artifacts | Included | Included |
| Dashboard, CLI, HTTP API, and MCP | Included | Included |
| Organisations, access tokens, maintenance mode, and telemetry | Included | Included |
| Active devices per installation | One | Device pool |
| Execution | Sequential | Parallel, with concurrency controls |
| Health-aware scheduling and device quarantine | — | Included |
| Route jobs by device tags | — | Included |
| Licence | AGPL-3.0-only | Commercial subscription |
| Price | Free | €99 per customer organisation/year |

Both editions run on your infrastructure. Pro is maintained separately;
dashboard organisations are access-control tenants, not separate subscriptions.
See [edition behaviour](docs/guide/editions.md) or [contact CodeBakery](mailto:hello@codebakery.net?subject=DeviceYard%20Pro).

## Get started

Use a host with **Node.js 22.13 or later**, npm, Android platform tools (`adb`),
and Maestro with its required Java runtime. Connect an Android device, enable
USB debugging, and accept its authorisation prompt. Native Linux is the
recommended starting point for a USB-connected farm. iOS is not supported.

### 1. Build Community

```sh
git clone https://github.com/nmehlei/DeviceYard.git
cd DeviceYard
npm ci
npm --prefix dashboard ci
npm run build -- --webpack
```

### 2. Configure and start your farm

Follow the [first-install guide](docs/guide/getting-started.md) to create a
private environment file, choose a persistent data directory, and start the
server. Open the dashboard on port 8080, sign in, and select your active device.
Use a TLS reverse proxy before making the farm remotely accessible.

### 3. Run your flows

From the machine containing your APK and Maestro project:

```sh
npm install -g @deviceyard/cli
deviceyard login --url https://your-farm.example.com
deviceyard whoami

# Replace 1 with your organisation ID.
deviceyard cloud app.apk e2e/scenarios \
  --org 1 \
  --report junit \
  --junit-path report.xml \
  --download-artifacts FAILED
```

The CLI connects to your running farm; it does not provision a hosted service.
For CI authentication and project layout, see the [CLI guide](docs/guide/cli.md).

## Documentation

| Task | Guide |
| --- | --- |
| Set up a farm and complete the first run | [Getting started](docs/guide/getting-started.md) |
| Submit tests from a terminal or CI | [CLI](docs/guide/cli.md) · [Running flows](docs/guide/running-flows.md) |
| Configure, back up, and maintain an installation | [Operations](docs/guide/operating.md) · [Maintenance](docs/guide/maintenance.md) |
| Connect coding agents or API clients | [MCP](docs/guide/mcp.md) · [API reference](docs/guide/api-reference.md) |
| Inspect and control devices | [Dashboard](docs/guide/dashboard.md) · [Remote control](docs/guide/remote-control.md) |
| Manage results and monitoring | [Artifacts and retention](docs/guide/artifacts-and-retention.md) · [Observability](docs/guide/observability.md) |
| Build a Linux container locally | [Docker guide](docs/guide/container.md) |

Docker is an optional Linux deployment path. Physical USB acceptance is still
pending, and prebuilt images are not published. Docker Desktop does not provide
the same USB access as Linux Docker Engine. These limits do not affect running
Community from source on a native host.

## Contributing and support

Bug reports and focused pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md)
for development and test commands. Use repository issues for reproducible bugs
and feature requests; include your version, host platform, and sanitised logs.

Report vulnerabilities privately using [SECURITY.md](SECURITY.md), rather than
posting sensitive details in an issue. For Pro subscriptions, contact
[hello@codebakery.net](mailto:hello@codebakery.net?subject=DeviceYard).

## Licence

First-party Community code is licensed under [AGPL-3.0-only](LICENSE).
Third-party components retain their own licences; see [third-party notices](THIRD_PARTY_NOTICES.md)
and [test-fixture attribution](tests/fixtures/README.md). Pro is separately licensed.

Built by [CodeBakery](https://codebakery.net), independent software made in Germany.
