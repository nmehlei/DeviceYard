# DeviceYard identity

DeviceYard is the product name. Use this spelling in UI, documentation, and
communications; `deviceyard` is the CLI and MCP server identity.

## Logo

The approved **C1 / Flow** mark combines a phone outline with branching test
paths. Navy `#071f36`, teal `#00bfa6`, and inverse white `#e6edf5` are the
brand colors. Keep the symbol's proportions and leave at least one endpoint
diameter of clear space around it. Avoid shadows, gradients, and stretching.

- [Light-background SVG](../../dashboard/public/brand/deviceyard-mark.svg)
- [Dark-background SVG](../../dashboard/public/brand/deviceyard-mark-dark.svg)

SVGs are the editable production masters. Run `node scripts/generate-brand-assets.cjs`
after installing dashboard dependencies to regenerate the favicon and Apple icon.
The dashboard uses the inverse
mark, paired with a live-text wordmark for accessibility. Email retains its
live-text DeviceYard wordmark so clients that block images still show the brand.

## Compatibility during the rename

This is an application rebrand, not a storage or infrastructure migration.
Existing installations continue to use:

- `/opt/mobile-device-farm/data` and the existing systemd/deployment paths.
- `MOBILE_FARM_URL` / `MOBILE_FARM_TOKEN` and `~/.mobile-farm` for existing MCP setups.
- The `mobile-device-farm` OpenTelemetry service default and instrumentation
  scopes, preserving existing dashboards and alert queries.
- Existing Azure project/repository, pipeline, service-connection and IaC identifiers.

The root private package is now `deviceyard-runner`; the published CLI already
uses `@deviceyard/cli`. The MCP handshake reports `deviceyard`, while its
existing configuration and credential locations continue working.

Rename external resources only with a coordinated migration of references,
credentials and deployment automation. Do not rename the persistent data
directory as part of a cosmetic upgrade.
