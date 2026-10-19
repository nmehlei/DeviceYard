# Your first DeviceYard farm

This guide starts Community from source with one USB-connected Android device.
It does not modify an existing farm or install a system service.

## Prerequisites

- Node.js 22.13 or later and npm.
- Android platform tools (`adb`).
- Maestro and the Java runtime required by your Maestro installation.
- An Android device with USB debugging enabled, plus an APK and Maestro flows.
- A writable persistent data directory outside the source/build directory.

Use a dedicated native Linux host for a long-running USB farm. Confirm `adb`,
`maestro`, and `java` are available to the account that will run DeviceYard.
Connect the device, accept its USB debugging prompt, and run `adb devices`.
Its status must be `device`, not `unauthorized` or `offline`. Do not attach a
device already in use by another farm or test session.

## Build

```sh
git clone https://github.com/nmehlei/DeviceYard.git
cd DeviceYard
npm ci
npm --prefix dashboard ci
npm run build -- --webpack
```

## Configure

Create an environment file outside the checkout, for example
`~/.config/deviceyard/server.env`, readable only by your service account
(`chmod 600`). Set the following variables using your own values:

| Variable | Value to supply |
| --- | --- |
| `DEVICE_ID` | The serial shown by `adb devices`. |
| `DATA_DIR` | An absolute, writable directory for the database and artifacts. |
| `TOKENS_JSON` | `{}` to create organisation tokens through the dashboard. |
| `ADMIN_USERNAME` | Your initial administrator username. |
| `ADMIN_EMAIL` | Your administrator email address. |
| `ADMIN_PASSWORD` | A strong unique password from your password manager. |
| `SESSION_SECRET` | A securely generated random value of at least 32 characters. |
| `TOKEN_ENCRYPTION_KEY` | A securely generated value of exactly 64 hexadecimal characters. |
| `PORT` | `8080`, or another available port. |

Use Node's environment-file format: one `NAME=value` entry per line, without
`export`. Quote values containing spaces or `#`. Keep the file and a secure
backup out of version control. Keep `TOKEN_ENCRYPTION_KEY` stable across
restarts and upgrades; it is required to decrypt stored tokens.

## Start and sign in

From the built checkout:

```sh
node --env-file="$HOME/.config/deviceyard/server.env" dist/entry.js
```

Open `http://localhost:8080` on the host and sign in with the administrator
credentials you configured. The HTTP listener can be reachable from other
machines: restrict network access during setup and use a TLS reverse proxy
before exposing the farm remotely. Never expose the ADB port.

In the dashboard, select the active Community device, create an organisation,
and manage its memberships and access tokens. Initial administrator and device
settings seed a new database; changing those environment variables is not a
replacement for managing an existing installation in the dashboard.

## Submit a run

Install the CLI on your development machine with `npm install -g @deviceyard/cli`.
Use `deviceyard login --url https://your-farm.example.com`, then
`deviceyard whoami` to find your organisation ID. Keep your flows under
`e2e/scenarios`; the CLI packages the surrounding `e2e` directory so relative
references travel with them.

```sh
deviceyard cloud app.apk e2e/scenarios --org 1 --report junit --junit-path report.xml
```

Replace `1` with your organisation ID. Follow the job in the dashboard and
inspect the flow results and artifacts. If the job stays queued, check that
an active Community device is selected, online, and not held by another job
or a remote-control session. See [the CLI guide](cli.md) for CI authentication
and [operations](operating.md) for operating requirements.

## Keep it running

The command above runs in the foreground. For unattended use, run the same
built entrypoint with your host's service manager under a dedicated account,
with the same private configuration, tool PATH, USB permissions, and durable
`DATA_DIR`. Avoid running two instances against one data directory.

Read [operations](operating.md) for configuration and backups and
[maintenance](maintenance.md) before upgrading. Packaging a native release is
documented separately in [native distribution](native.md). Docker users should
read the [Linux container guide](container.md), including its USB limitations.
