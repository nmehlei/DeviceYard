# Contributing to DeviceYard Community

Use Node.js 22.13 or later and npm. Install dependencies from the lockfiles:

```sh
npm ci
npm --prefix dashboard ci
npm test -- --runInBand --watchman=false --testTimeout=30000
npm --prefix dashboard test -- --runInBand --watchman=false
npm run build -- --webpack
node ci/check-boundary.cjs
node ci/smoke.cjs
```

Work on a branch and open a pull request with a description of the problem,
the change, and validation. Keep changes focused. Include regression coverage
for behavior changes. The Azure pipeline validates server, CLI, dashboard,
native packaging, and container behavior.

Community supports one active device and sequential execution. Shared extension
interfaces belong here; proprietary Pro implementations do not. Keep credentials,
local runtime configuration, databases, and job artifacts out of commits.

Normal tests use fake device command runners. Real-device tests require an
explicitly reserved device and isolated data directory; never use a production
farm or interfere with running jobs. See [operating](docs/guide/operating.md)
and [maintenance](docs/guide/maintenance.md).

Keep guides aligned with behavior. Preserve third-party attribution and record
the origin and hashes of any new binary fixture. First-party contributions are
covered by the repository's AGPL-3.0-only licence.

Report security issues privately as described in [SECURITY.md](SECURITY.md).
