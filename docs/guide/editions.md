# Community and Pro

Both editions run on your infrastructure. Community is free and licensed under
AGPL-3.0-only. Pro adds multi-device operation for **€99 per customer organisation
per year**, covering that organisation's own installations. Dashboard
organisations are access-control tenants, not separate subscriptions.

| Capability | Community | Pro |
| --- | --- | --- |
| Active devices per installation | One | Multiple |
| Job execution | Sequential | Parallel, with a configurable cap |
| Dashboard, CLI, HTTP API, MCP, and artifacts | Included | Included |
| Maintenance mode and OpenTelemetry | Included | Included |
| Health-aware scheduling and quarantine | — | Included |
| Device-tag routing | — | Included |
| Work-profile isolation | — | Included |

Community retains device registrations and history when you switch its active
device. Stop or finish work and close remote-control sessions before changing
that selection. For Pro, see [device routing](device-routing.md), [isolation](isolation.md) and
[pricing](https://deviceyard.codebakery.net/pricing/).

## Install and activate

Start Community using [Getting started](getting-started.md). Native hosting and
Docker use the same edition limits; a container does not unlock Pro features.

Pro is distributed separately. Contact [CodeBakery](mailto:hello@codebakery.net?subject=DeviceYard%20Pro)
for a subscription and installation instructions. Configure the customer ID
provided for your organisation and upload the issued licence file using an
administrator account. Licence verification is offline; a valid Pro
distribution includes CodeBakery's verification keys.

Keep persistent data and the licence outside replaceable application files.
Never send your licence, tokens, or runtime configuration in a public issue.

## Selection and expiry

Select a Community fallback device while Pro is active. That choice persists
independently of pool enrollment. Device registration, labels, job history,
events, and artifacts remain intact.

A valid expired Pro licence has seven days of grace, measured from its signed
expiry time. After grace, new pooled work stops. Running tests finish, then the
selected available Community device can take one job at a time. Without a
selected device, work remains queued. Interactive sessions on devices becoming
unavailable receive a five-minute warning before disconnection; expiry does not
reboot a device.

Renewing Pro restores the preserved pool configuration. A missing, corrupt,
wrong-customer, future, or otherwise invalid licence does not earn grace and
uses Community behaviour. Jobs requiring device tags remain queued when Pro
routing is unavailable; see [device routing](device-routing.md).

## Upgrades

Before changing editions or upgrading, use [maintenance mode](maintenance.md),
drain active jobs, and back up the database, job inputs, artifacts, and private
configuration. Retain a matching application version and data backup for
rollback. Do not run two installations against the same data directory.

See [operations](operating.md) for configuration, [native packaging](native.md)
for maintainer build tooling, and [the API reference](api-reference.md) for
integration contracts.
