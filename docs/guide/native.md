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

Community Git history and `GitVersion.yml` are the shared release-version source.
The local .NET tool manifest pins GitVersion **5.12.0**, using **Mainline** mode
as the original MobileDeviceFarm pipeline did. Full history and tags are required;
shallow checkouts fail closed. The release number is calculated from history and
release tags, not forced to a package.json value or a fixed `next-version`.
Pro invokes `core/ci/native/version.cjs` from its pinned Community checkout and
inherits that same version; it must not choose an independent release number.
Calculation uses an isolated mainline checkout at that exact commit, without
later remote branches/tags or Pro build-server variables influencing the result.
Ordinary main commits/merges increment the patch version. Use `+semver: minor`
or `+semver: major` for deliberate larger increments, or `+semver: none` to skip.

Normal builds use `<shared-version>-ci.<build-id>` (for example
`1.0.0-ci.123`). Build IDs identify distinct CI artifacts; they do not define
separate Community and Pro release series. For stable packaging, manually run
the edition's pipeline on `main` with `nativeReleaseMode=stable`. There is no
free-form version input. Before promotion, confirm both edition manifests have
the same version and the same Community source revision. If Pro needs a release
fix, record the release coordination in Community (a mainline commit advances
the shared version) and update Pro's pin before building
the pair. Never republish different bytes under an existing stable version.

Legacy versions `0.0.0-ci.<build-id>` also identify CI candidates. The
manifest deliberately has `productionReady: false`. Distribution notice/source
review, Pro activation, promotion authorization and migration rehearsal remain
release gates. The runtime archive is not a corresponding-source distribution.
See the [migration design](../superpowers/specs/2026-10-12-native-release-migration-design.md)
and [maintenance guide](maintenance.md).

## Reviewed promotion (not part of CI)

After separate approval of the exact archive, notices/source correspondence and
deployment plan, `ci/native/promote.cjs` can publish into an existing authorized
storage container. It never creates resources or changes the legacy marker.
The command requires an explicit `--reviewed-and-approved` flag; Pro also needs
every bundled verification-key ID named as an additional reviewed argument.
An empty or unreviewed Pro key set is rejected. The account identity must already
have the reviewed storage permission. This command has not been run as part of
the migration preparation.

The target is `native/<edition>/linux-x64/`: immutable archive first, then
`latest.json`. A failed promotion after archive upload leaves the old marker
intact; inspect that state before retrying, as existing archives are not
overwritten. Keep the old artifact and matching data backup for rollback.
