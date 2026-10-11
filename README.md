# DeviceYard Community

Run Android tests on hardware you own, with a dashboard, HTTP API, CLI and MCP client.

Community runs one active device and one test at a time per installation. Device history and registration are retained when switching the active device. DeviceYard Pro adds a device pool and parallel execution.

## Build from source

Use Node.js 22.13 or later and npm. Install Android platform tools (`adb`) and Maestro separately for hardware execution. Pair or authorize the Android device and check that `adb devices` reports it as available.

```sh
npm ci
npm --prefix dashboard ci
npm run build
npm test -- --runInBand
npm --prefix dashboard test -- --runInBand
```

The build includes dashboard assets, the MCP client, CLI, CLI installer, and the scrcpy server with its upstream license. Start the compiled CLI with `node dist/cli.cjs --help`.

## Run

Set `DATA_DIR` to a durable directory outside the checkout. Configure `DEVICE_ID`, `ADMIN_USERNAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SESSION_SECRET`, and `TOKEN_ENCRYPTION_KEY` as described in [configuration](docs/guide/environment-variables.md). Generate your own secrets; do not commit them. Keep the encryption key stable across restarts and back it up with the database. `TOKENS_JSON` is required; use an empty JSON object if you do not need initial organisation-token seeding.

Run `npm start`. Use a TLS reverse proxy for remote access. One server process per data directory is supported. Select the active device in the dashboard before submitting work. Build output is disposable; the database and artifacts are not.

See the [user guide](docs/guide/index.md) for setup, authentication, API, CLI, MCP, and remote control.

A Linux USB [container release candidate](docs/guide/container.md) can be built locally. Public images and hardware acceptance are pending.

## License and release status

First-party Community code is intended for AGPL-3.0-only distribution; third-party components retain their licenses. This checkout is a private migration candidate. Public release awaits provenance and dependency review. It is not a production deployment or a commercial license grant for Pro.
