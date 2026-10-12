# Native release candidates

Native/systemd remains the recommended deployment for USB-connected farms.
The existing Azure Pipelines build these candidates from GitHub; there is no
GitHub Actions workflow. The candidate artifacts do not change the production
updater or publish a release. Linux x64 is the initial validated target.

The Community pipeline builds the application and dashboard, records dependency
notices, installs production dependencies in an isolated temporary directory,
and creates a native archive plus SHA-256 manifest. It extracts that archive and
tests the existing systemd entrypoint (`node dist/index.js`), authentication,
edition enforcement, static assets, version reporting and maintenance across a
restart. It requires neither a source checkout nor development dependencies at
runtime. The bundled MCP client is available through the usual HTTP endpoint;
the bundled CLI can be run with `node dist/cli.cjs`.

On the release builder, after the normal build:

```sh
node ci/notices.cjs
node ci/native/package.cjs /tmp/deviceyard-candidate 0.0.0-candidate.1
node ci/native/smoke.cjs /tmp/deviceyard-candidate/deviceyard-community-0.0.0-candidate.1-linux-x64.tar.gz.json
```

The native archive does not install Node, ADB, Java or Maestro. These remain host
prerequisites; use the tested Node 22 runtime and the existing farm toolchain.
Keep configuration and DATA_DIR outside the replacement archive. Do not run two
instances against one data directory or use a test instance with live devices.

Versions `0.0.0-ci.<build-id>` identify CI candidates, not stable releases. The
manifest deliberately has `productionReady: false`. Distribution notice/source
review, Pro activation, promotion authorization and migration rehearsal remain
release gates. The runtime archive is not a corresponding-source distribution.
See the [migration design](../superpowers/specs/2026-10-12-native-release-migration-design.md)
and [maintenance guide](maintenance.md).
