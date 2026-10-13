# Community and Pro release candidates

Community supports one active Android device per installation. Pro adds the device pool and parallel execution for **€99 per customer organisation/year**, covering that organisation's own installations. Dashboard organisations are access-control tenants, not separate subscriptions.

These are internal release candidates. This change does not publish AGPL source, provision signing keys, enable checkout, or change the currently deployed updater channel.

## Build

Community is built from `nmehlei/DeviceYard`. Pro is built from the separate
private `nmehlei/DeviceYard-Pro` repository, which pins Community as its `core`
submodule. Both use their existing Azure Pipelines; source hosting on GitHub
does not move CI to GitHub Actions.

From a clean Community checkout:

```sh
npm ci
npm --prefix dashboard ci
npm run build -- --webpack
npm start
```

In the Pro repository, initialize the pinned submodule and follow its README:
assemble, install dependencies in `.build` and `.build/core/dashboard`, then
build. `DEVICEYARD_VERIFICATION_KEYS_FILE` optionally supplies a JSON map of
reviewed key IDs to **Ed25519 public PEM keys** before assembly. Private keys
are rejected. Omitting it builds a fail-closed candidate with no trusted
issuers; do not distribute that candidate as an activated Pro release.

See [native release candidates](native.md) for isolated packaging and extracted
archive validation. Native archives retain the `dist/index.js` entrypoint used
by systemd; it starts the correct edition. They do not use a legacy unlicensed
application entrypoint. The old MobileDeviceFarm application repo is a migration
source, not a third maintained edition.

Both editions retain the existing environment requirements and DATA_DIR. Pro
additionally requires `DEVICEYARD_CUSTOMER_ID`, matching the signed commercial
customer identity. Keep persistent data and entitlement outside the archive.

## Entitlements

The JSON envelope has base64url `payload` and `signature` strings. Sign the decoded UTF-8 payload bytes using Ed25519. Claims are:

```json
{
  "version": 1,
  "issuer": "codebakery",
  "audience": "deviceyard-pro",
  "kid": "release-key-id",
  "licenseId": "opaque-license-id",
  "customerId": "customer-organisation-id",
  "tier": "pro",
  "notBefore": 1790114400000,
  "expiresAt": 1821650400000,
  "capabilities": ["multi-device"]
}
```

Timestamps are UTC milliseconds. The example is illustrative, not an entitlement. The signing key stays outside the application/repository and is never shipped. Deploy reviewed verification keys in the Pro build. Admins upload the issued file on Devices, or POST a `license` string to `/api/edition/license` using an authenticated administrator session. It is stored under DATA_DIR as `pro-license.json` with mode 0600 and replaced atomically. Invalid replacements preserve the prior license. Status APIs never return license contents.

No online verification is required. An offline key cannot prevent a machine administrator from patching code, copying data, or manipulating the clock; commercial terms and the private implementation are the protection. There is no instant remote revocation in this design.

## Selection and expiry

Choose a Community fallback while Pro is active. The selection persists independently of pool enrollment flags. Disable scheduling, allow jobs to finish, and close live views before selecting another device. Registration, labels, events, job history, and artifacts remain intact.

A valid expired Pro license has seven days' grace, calculated from its signed expiry, not installation/restart. After grace no new pooled work starts. Running tests finish; then the selected enrolled Community device can take one job at a time. Without a selected device, work remains queued. Existing interactive sessions on unavailable devices receive a five-minute warning, then disconnect. No job is killed and no device is rebooted for license expiry.

Renewing Pro restores the preserved enrollment configuration. A missing, corrupt, wrong-customer, future, or otherwise invalid entitlement never earns grace and falls back to Community behaviour.

## API additions

- `GET /api/edition`: authenticated state, effective capabilities, fallback ID, expiry timestamps and Community queue blocking reason (device required, unavailable, or busy). Offline fallback devices leave jobs queued until reconnect.
- `POST /api/edition/device`: administrator-only `{ "deviceId": "registered-id" }`.
- `POST /api/edition/license`: administrator-only `{ "license": "signed-file-contents" }` on Pro builds.
- Device listing adds `isAvailable` and `edition`; existing fields and CI routes remain compatible. Hardware actions on unavailable devices return 409 `PRO_REQUIRED`; busy selection returns 409 `DEVICE_BUSY`.

## Rollout gates

Before deploying, issue the current installation an entitlement with its reviewed verification key, select a fallback, test migration against a database copy, drain work, and select a separate edition release channel. Never replace the existing updater's legacy bundle with Community implicitly. Schema 12 is additive; prior private binaries can ignore the edition table, but verify rollback with the intended binary and database backup.

Before public source release, review ownership/dependencies, apply the unchanged AGPL text and package license notices, publish version-matched corresponding source/build instructions, and verify all public archives and history contain no proprietary implementation. Pro commercial terms and contribution permissions require review. Run a two-device hardware smoke test before describing parallel execution as hardware-validated. Tax treatment and payment/subscription terms remain launch decisions.
