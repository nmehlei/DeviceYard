# Publication audit status

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
