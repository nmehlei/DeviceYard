# Community container

The container packages the Community server, dashboard, CLI/MCP assets,
Maestro 2.6.1, Java, Android platform tools and scrcpy. Community runs one
active device per installation. This guide does not change Pro licensing.

The initial target is **Linux amd64 with USB-connected Android phones**.
Docker Desktop can validate startup but is not a substitute for Linux USB
testing. Every release is published as an image for **linux/amd64 only** (no
arm64 variant):

```sh
docker pull ghcr.io/nmehlei/deviceyard:<version>
```

Tags per release are `<version>`, `<major>.<minor>`, `<major>` and `latest`;
pin an exact version (or digest) for production. The same release, with the
native archive and `SHA256SUMS`, is listed on
[GitHub releases](https://github.com/nmehlei/DeviceYard/releases). Building
locally from this checkout remains an alternative (see below).

## Prepare the host

Use Docker Engine with the Compose plugin. Set up a host group named
`deviceyard-usb` and a udev rule granting it read/write access to the specific
Android devices you intend to use. For example, adapt the vendor and product
IDs below from `lsusb`; do not grant access to unrelated USB devices:

```text
SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="<vendor-id>", ATTR{idProduct}=="<product-id>", MODE="0660", GROUP="deviceyard-usb"
```

Install the rule under `/etc/udev/rules.d/`, reload the rules, and reconnect
the intended idle phone. Enable USB debugging and accept its authorization
prompt. Obtain the group's numeric GID with `getent group deviceyard-usb` and
set `DEVICEYARD_USB_GID` to that GID. The runtime user has UID/GID 1000; the
additional USB group grants access without privileged mode. Rootless Docker
and user-namespace remapping need additional permission mapping and are not
part of this initial supported configuration.

The container owns its ADB daemon. Stop conflicting host ADB use only after
coordinating with other users of the device. It listens inside the container
on 127.0.0.1:5037; never publish that port. Both CLI operations and scrcpy use
this same daemon.

## Supply configuration

Create a private env file outside the checkout, readable only by its owner
(mode 0600). Supply the variables below with your own values:

- `DEVICE_ID`: the Android serial, used for initial device registration.
- `TOKENS_JSON`: `{}` for no initial organization-token seeding.
- `ADMIN_USERNAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`: initial administrator.
- `SESSION_SECRET`: at least 32 characters, generated securely.
- `TOKEN_ENCRYPTION_KEY`: exactly 64 hexadecimal characters, generated securely.

See [operating](operating.md) for additional settings. Generate credentials
with your password manager or secret manager. Keep the encryption key stable
across upgrades and back it up securely with the data. Do not paste resolved
Compose configuration or `docker inspect` environment output into tickets.

Set `DEVICEYARD_ENV_FILE` to the **absolute path** of that file. Compose fixes
the application data path to `/data`, HOME to `/home/deviceyard`, and the
internal HTTP port to 8080 so they match its volumes and port mapping.

```sh
docker compose -f ci/container/compose.yaml config --quiet
docker compose -f ci/container/compose.yaml up --build -d
docker compose -f ci/container/compose.yaml exec deviceyard adb devices
```

Open `http://127.0.0.1:8080` and select the active device in the dashboard.
`DEVICEYARD_HTTP_PORT` changes the loopback host port. Put an HTTPS reverse
proxy in front for remote access; the Compose default does not expose HTTP
to the LAN. The image health check verifies HTTP availability, not whether
a phone is connected. Unauthorized/offline phones appear through the normal
device status behavior.

## Persistence and upgrades

Compose creates separate `data` and `adb-identity` named volumes. A new named
volume inherits the image directory's ownership. Existing volumes must be
writable by UID 1000; the entrypoint does not recursively chown operator data.
The data volume holds SQLite and job artifacts; the ADB volume holds device
authorization keys. Treat both as private. Do not use `down --volumes` for an
upgrade: that deletes persistent state.

Drain running work, stop the service, and back up both volumes plus the private
runtime configuration before upgrading. Use a consistent stopped database
backup. Recreate the container with a tested image, retaining the same Compose
project name and volumes. For rollback, retain the prior image and compatible
backup; do not assume an older binary supports a newer database schema.

To run a published image, set `DEVICEYARD_IMAGE` to an exact version or
digest from `ghcr.io/nmehlei/deviceyard` (for example
`ghcr.io/nmehlei/deviceyard:<version>`) and use `up --no-build`. Without it,
Compose builds the local image from this checkout. Use only one runner
container per data volume. Container builds do not alter the existing systemd
farm deployment or updater.

## Validation and notices

As an alternative to a published image, build and verify locally:

```sh
docker build --platform linux/amd64 -f ci/container/Dockerfile -t deviceyard-community:test .
node ci/container/smoke.cjs deviceyard-community:test
```

The smoke harness creates and removes its own containers and volumes; it
never attaches USB devices. It checks tools, non-root execution, Community
identity, persistent login and ADB identity, graceful stop, and sanitized
configuration failures. Real-device acceptance additionally requires APK
installation, a Maestro flow, screenshot/control and unplug/replug on Linux.

Runtime notice locations and exact OS package versions are recorded under
`/opt/deviceyard/notices`. Test APKs and development dependencies are excluded
from the runtime image. See [publication audit](../licenses/publication-audit.md)
for remaining source and redistribution checks.
