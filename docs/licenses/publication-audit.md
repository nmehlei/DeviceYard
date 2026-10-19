# Publication audit status

## Fixture follow-up — 2026-10-19

Both retained APKs match the official `appium/sample-apps` repository at
`0e92532585431d3b362c1ff12c65b54936fbe26f`, including the previously unresolved
Selendroid blob `55cf569fb7fe1cd707a71d3fc5fef2e55cef8c3d`. The older
`appium/sample-code` location checked below contains a different Selendroid APK.
The exact binary source is now documented; replacing or rewriting history for
an unknown binary origin is no longer proposed.

Fixture hashes, upstream source-header evidence, Apache-2.0 licence text, and
Android/Appium/Selendroid/Commons IO attribution are preserved under
[tests/fixtures](../../tests/fixtures/README.md). Commons IO's notice is from
upstream commit `5d4d09928e154d083f396a1555da72dfe9d877d1` (2.2).
This resolves the fixture provenance/notice follow-up, not binary-release
dependency review or approval to change repository visibility.

The guide's edition wording and three broken local links have been corrected;
contribution and private security-reporting instructions have been added.

## Historical audit — 2026-10-11

Checked 2026-10-11. This is an evidence record, not public-release approval.

## Dependency notices

`node ci/notices.cjs` records 1,205 installed dependency entries. It now
captures README-embedded license grants when no standalone license file is
present. This adds six previously omitted notice texts, including
`cookie-signature`. All installed root production dependencies have captured
notice text. This does not prove coverage of other operating systems or every
component embedded in a compiled distribution.

26 entries still have no captured notice text. Four are dashboard dependencies
not marked dev in its lockfile: `@img/sharp-libvips-darwin-x64`, `@next/env`,
`@next/swc-darwin-x64`, and `client-only`. The dashboard is a static export;
its entire node_modules directory must not be treated as shipped runtime.
Review the actual exported/bundled contents and collect their applicable
notices before publishing an artifact. Generate the inventory on the release
platform too, since optional native packages differ by platform.

## APK fixtures

- `ContactManager.apk`: Git blob
  `418f504bde28ee5fae806e2e060f488e7abe791f` matches
  [Appium sample-code](https://github.com/appium/sample-code/tree/f3ed882ec9e6318c4150e515e162b579fd4752b1/sample-code/apps/ContactManager).
  Preserve applicable upstream license/attribution alongside the fixture.
- `selendroid-test-app.apk`: the retained binary reports version
  `0.12.0-SNAPSHOT`. It matches the fixture in `nmehlei/app-binary-info`,
  introduced by commit `18c64302908fd943ec58d61053088b3907291f18`.
  That commit describes an Appium sample but does not supply its download URL.
  The current Appium sample-code Selendroid APK has a different Git blob,
  `6a498e3612cea8316acc51cea74759c46c122865`, so it is not evidence for this
  exact binary. Original upstream binary provenance remains unresolved.

Changing or removing a fixture at HEAD does not remove earlier copies from
Git history. Audit all history intended for public visibility, not only the
latest tree. Do not rewrite the shared history without separate approval.

## Remaining checks

- Finish exact fixture provenance and applicable notices.
- Inspect the complete public Git history and source inventory for private
  code, configuration, and credentials using redacted findings only.
- Review compiled distribution contents and release-platform notices.
- Obtain the separately agreed approval before changing source visibility or
  publishing registry artifacts.
