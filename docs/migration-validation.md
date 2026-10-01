# Private migration validation

Source baseline: `493b5f9e15d36c88c37e2072ed5a76f704c5e1c7`. No private history imported.

- Clean npm installs succeeded for server/CLI and dashboard.
- Dashboard: 267 tests passed.
- Core/CLI: 1251 of 1254 tests passed in the full run; the three failed suites passed on targeted reruns. A clean final full run is pending. No failures were suppressed.
- Full build passed with `npm run build -- --webpack`. Turbopack's local worker could not bind a port, including on an escalated attempt; webpack is a supported verification alternative.
- Compiled runtime smoke test passed: dashboard served, login worked, `/api/edition` reported Community with multi-device disabled.
- Source boundary scan passed. This is not a complete secret or provenance audit.

Remaining publication gates: APK fixture provenance, full dependency notice inventory (including dashboard build dependencies), final secret/source audit, isolated public CI, and explicit publication approval. No production release or updater changes have been made.

Tests with fake Android command runners now answer `adb get-state` as well as discovery. Tests for a device disappearing during job startup continue to exercise that later failure after a successful scheduler probe.

Third-party metadata inspection found missing license fields for busboy, streamsearch, and exit; their installed license files carry MIT permission text. Dashboard dependencies include LGPL libvips, MPL tooling, and CC-BY caniuse data. Distribution review must distinguish static output from build-tool packages; do not claim lockfile metadata alone establishes compliance.
