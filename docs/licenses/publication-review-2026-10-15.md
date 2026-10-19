# Community publication review — 2026-10-15

Update 2026-10-19: the exact Selendroid binary has now been located in Appium's
official sample-apps repository. Both fixtures have documented hashes and
preserved licence/notice files. The guide corrections and contribution/security
instructions below have been implemented. See [the follow-up](publication-audit.md).
The original findings below are retained as a dated record. Binary-distribution
review, first-install documentation and the final visibility review remain open.

Decision: **do not change repository visibility yet**. This is an audit of the
source repository, not approval to publish it or to promote runtime artifacts.

## Scope and evidence

- Repository: `nmehlei/DeviceYard`, still private; main revision
  `f47273fc4b65dc9b3f3456b1468c2f019671e4b8`.
- Fetched remote history: 28 reachable commits, 577 unique blobs, 492 paths.
  The seven advertised branch heads and six PR heads are all represented in
  the fetched history. No advertised tags or GitHub releases were present.
- Gitleaks 8.30.1 was downloaded from its official GitHub release and checked
  against the release checksum manifest. Default-rule Git scan used
  `--log-opts='--all --full-history' --redact=100 --ignore-gitleaks-allow`.
  It reported 21 diff-bearing commits scanned and **zero findings**. The
  independent tree traversal counted merge commits as well (28 total).
- A current-tree scan with archive traversal depth 2 also reported zero
  findings. No tracked `.env`, private-key, SQLite/database, or Terraform-state
  filenames were found in the traversed history.
- `node ci/check-boundary.cjs` passed. A separate unique-blob search across
  history found no known `PoolScheduler`, `LicenseStore`, or `ProPolicy` class
  declarations or imports from `/pro/`. Reviewed current scheduler/runtime
  entrypoints select `SingleDeviceScheduler` and `CommunityPolicy`.
  Shared extension interfaces and packaging support for a Pro caller are
  intentional; these are not the private Pro implementations.
- Community CI uses `ubuntu-latest`, does not persist checkout credentials,
  and has no deployment or registry publication step. Azure pipeline 62's
  current PR settings enable forks but set both `allowSecrets` and
  `allowFullAccessToken` to false.

Secret scanning is heuristic, not proof that no secret exists. Binary scanning
does not establish the provenance of compiled code. This review did not audit
GitHub issue/PR comment bodies, attachments, or account-level security settings.
Those should be checked immediately before a visibility change, along with any
new commits since the revision above.

## Source-publication blockers

### Bundled APK provenance and notices

Both APK fixtures remain in current source and earlier history. Neither APK
contains an obvious license/notice file by archive-entry name, and there is no
fixture-specific notice alongside them.

| Fixture | Git blob | Finding |
| --- | --- | --- |
| `ContactManager.apk` | `418f504bde28ee5fae806e2e060f488e7abe791f` | Exact upstream blob is known; collect and preserve applicable source attribution and notices. |
| `selendroid-test-app.apk` | `55cf569fb7fe1cd707a71d3fc5fef2e55cef8c3d` | Matches the copy in `nmehlei/app-binary-info`, but that is not evidence of original upstream provenance. |

Rechecked Appium sample-code tree
[`47fc0305396b8322b727820ca55a07607395040c`](https://github.com/appium/sample-code/tree/47fc0305396b8322b727820ca55a07607395040c):
ContactManager matches, while its Selendroid blob is
`6a498e3612cea8316acc51cea74759c46c122865`, **not** the retained binary.
The repository has upstream LICENSE and NOTICE files; a repository-level
license alone does not identify every component embedded in a particular APK.

Recommended next work: resolve the exact fixture provenance and notices first.
If this cannot be established, replace the fixture with a reproducible test
artifact of known origin and propose a separately approved history-cleanup
plan. Removing the file only at HEAD leaves the original downloadable through
history. Do not rewrite shared history or delete remote refs as part of this audit.

## Documentation cleanup before opening the source

- `docs/guide/index.md` describes unrestricted pool scheduling without the
  Community/Pro distinction. Community is one active device and sequential
  execution; pool scheduling belongs to Pro.
- Guide links to missing files: `environment-variables.md` and `cli.md` link to
  `../open_issues.md`; `operating.md` links to `../../HANDOVER.md`.
- Guides, source comments, and fixtures retain internal project names such as
  DonableApp/donable. These are not credential findings. Generalize customer
  references and example organisation names in public-facing material.
- README, MIGRATION.json and older validation notes still describe a private
  migration candidate. Update current onboarding/status once publication
  blockers are resolved; retain historical evidence as historical evidence.
- Native and container instructions exist, but the native guide primarily
  documents packaging/promotion rather than a complete first-install systemd
  walkthrough. The README provides source-build startup instructions. Neither
  guide is integrated into the public homepage yet.
- SECURITY.md and CONTRIBUTING.md are absent. Add a private vulnerability-report
  route and a concise contribution/test guide before inviting contributions.

## Separate gate: binary/container distribution

The checked-in inventory contains 1,205 dependency entries, with 26 entries
without captured notice text. Four of those are dashboard entries not marked
development-only: `@img/sharp-libvips-darwin-x64`, `@next/env`,
`@next/swc-darwin-x64`, and `client-only`.

Review the actual Linux runtime archive and exported dashboard, regenerate
release-platform notices, and establish source correspondence before publishing
binaries. An installed build dependency is not automatically a shipped runtime
component; conversely, bundling code can carry it into the exported assets.
The missing-notice count by itself is neither a license-compatibility verdict
nor proof that all 26 packages are redistributed with the source repository.

Docker physical-device acceptance remains distinct from public source access.
No hardware tests, release promotion, production changes, or visibility changes
were performed for this audit.

## Next decision

Finish the fixture evidence and bounded documentation fixes. Then re-scan the
final revision and GitHub-facing metadata and request approval for the exact
repository visibility change. Update the homepage's Community links only after
anonymous access has been verified.
