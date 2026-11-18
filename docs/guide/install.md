# Install DeviceYard

DeviceYard ships as a Docker image and as a precompiled Linux x64 archive. Both
editions use the same runtime configuration; Pro additionally needs a customer
ID and a licence file. To build from source instead, see
[Getting started](getting-started.md).

| | Community | Pro |
| --- | --- | --- |
| Image | `ghcr.io/nmehlei/deviceyard:<version>` | `ghcr.io/nmehlei/deviceyard-pro:<version>` (not yet published) |
| Archive | `deviceyard-community-<version>-linux-x64.tar.gz` | `deviceyard-pro-<version>-linux-x64.tar.gz` |
| Download page | [GitHub releases](https://github.com/nmehlei/DeviceYard/releases) | [Pro releases](https://deviceyard.codebakery.net/pro/releases/) |

Each release also carries the archive's `.json` manifest and a `SHA256SUMS`
file; Pro releases add the Pro licence text. Images are published for
**linux/amd64 only**. Pin an exact version (or image digest) in production;
the `latest`, `<major>` and `<major>.<minor>` tags move with each release.

Pro archives are listed on the Pro releases page once Pro is generally
available; the Pro image is announced there when it is published. Until then,
contact [CodeBakery](mailto:hello@codebakery.net?subject=DeviceYard%20Pro).

## Install with Docker

Prepare the host (USB access group, udev rule, private env file) as described
in the [Linux container guide](container.md); the same preparation applies to
the Pro image. Then point Compose at the published image instead of a local
build:

```sh
export DEVICEYARD_ENV_FILE=/absolute/path/to/server.env
export DEVICEYARD_USB_GID=<numeric gid of deviceyard-usb>
export DEVICEYARD_IMAGE=ghcr.io/nmehlei/deviceyard:<version>
# Pro, once published: ghcr.io/nmehlei/deviceyard-pro:<version>

docker pull "$DEVICEYARD_IMAGE"
docker compose -f ci/container/compose.yaml up --no-build -d
```

`compose.yaml` is in the Community repository under `ci/container/`; take it
from the release tag matching your version and save it at that path, or adjust
`-f`. For Pro, add `DEVICEYARD_CUSTOMER_ID` to the private env file (see
[Add your Pro licence](#add-your-pro-licence)).

## Install from a release archive

The archive contains the compiled server, dashboard, CLI/MCP assets and their
production dependencies. It does not contain Node.js, ADB, Java or Maestro;
install Node.js 22.13 or later and the other tools on the host as listed in
[Getting started](getting-started.md#prerequisites) (npm is not needed). For
Pro work-profile isolation, also install the Maestro build described in
[isolation](isolation.md); the Pro image bundles it.

1. Download the archive and `SHA256SUMS` for one version into an empty
   directory: Community from its GitHub release, Pro from the Pro releases page.
2. Verify the checksum before extracting:

   ```sh
   sha256sum -c --ignore-missing SHA256SUMS
   ```

   The archive's line must read `OK`. Do not extract an archive that fails or
   is not listed.
3. Extract into a new, versioned directory, for example
   `/opt/deviceyard/<version>`. Keep configuration and `DATA_DIR` outside it so
   an upgrade only replaces the application directory.

   ```sh
   mkdir -p /opt/deviceyard/<version>
   tar -xzf deviceyard-<edition>-<version>-linux-x64.tar.gz -C /opt/deviceyard/<version>
   ```

4. Create the private env file as described in
   [Getting started](getting-started.md#configure) (Pro: add
   `DEVICEYARD_CUSTOMER_ID`), then start the server:

   ```sh
   node --env-file="$HOME/.config/deviceyard/server.env" /opt/deviceyard/<version>/dist/index.js
   ```

For unattended use, run the same command under your service manager with a
dedicated account. `BUILD_INFO` in the extracted directory records the version
and source revisions; `notices/` holds the licence and third-party notices.

## Add your Pro licence

Pro needs two things from your subscription: your customer ID and a signed
licence file (JSON).

1. Set `DEVICEYARD_CUSTOMER_ID` to your customer ID in the private env file. The
   Pro build refuses to start without it.
2. Sign in to the dashboard as an administrator, open **Devices**, and upload the
   licence file under **Pro license file**.
3. On the same card, select a Community fallback device. It takes one job at a
   time if the licence lapses; without it, new work stays queued.

DeviceYard verifies the licence offline against the verification keys bundled
in the Pro release and stores it as `pro-license.json` in `DATA_DIR`, so it
survives upgrades and image replacements. Without a valid licence, Pro runs
with Community behaviour (one active device). See [editions](editions.md) for
expiry and grace. Never share the licence file, customer ID or env file in a
public issue.

## Upgrade

Use [maintenance mode](maintenance.md) to drain work, back up `DATA_DIR`, the
ADB keys (`~/.android` of the service account; for Docker, the `data` and
`adb-identity` volumes) and the private configuration, then switch to the new
image or archive directory. Keep the previous version and its matching backup
for rollback; an older version may not read a newer database schema.
