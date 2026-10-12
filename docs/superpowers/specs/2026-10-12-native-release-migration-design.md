# Native releases from the two GitHub repositories

Status: implementation approved on 2026-10-12, explicitly retaining Azure Pipelines. Production deployment and release publication still require separate approval.

## Decision

DeviceYard owns shared application code; DeviceYard-Pro owns commercial extensions and pins Community. Both remain built by Azure Pipelines. Native/systemd and Docker are deployment formats, not additional application repositories. Stop backporting features to the ADO MobileDeviceFarm repository.

Prepare and validate native release candidates in the existing Azure Pipelines connected to the GitHub repositories. No GitHub Actions migration. Cut over the farm only after explicit deployment approval. Keep the old release channel available for rollback until the migration is accepted.

## Audit, 2026-10-12

- Community main `b8a6065` contains merged maintenance PR #4; Pro main `8c7ba55` contains merged integration PR #3.
- The split baseline was legacy commit `493b5f9`. The only subsequent application feature on legacy main `8d7bafa` is device setup checks, merged in ADO PR #793: ADB authorization timeout and install-verification warnings, admin fixes, UI, API, tests and documentation. Port it to Community and update Pro's core pin. Preserve maintenance and edition restrictions on the fix endpoint.
- ADO maintenance PR #945 is now draft/on hold. Its additional legacy implementation is not needed for the target architecture; close it after GitHub parity and migration readiness are established.
- GitHub pipelines currently build/test only. The legacy pipeline packages native bundles and publishes a shared `latest.json` watched by the farm.
- Community already generates the compatible `dist/index.js` forwarder. Pro starts at `dist/src/entry.js`; its native package needs a forwarder to that edition entrypoint, never to an unlicensed legacy entrypoint.
- Pro's public verification-key map is empty. A production migration must install a reviewed public verification key and valid customer entitlement before allowing pooled work. Never embed a private key in code, artifacts, CI logs or a native bundle.
- Farm provisioning and updater templates are currently in NME-IaC under `solutions/mobile-device-farm`. The homepage/platform split does not require another infrastructure relocation here.
- The current updater checks queued/running jobs, but does not use maintenance readiness or verify a bundle digest. It must be adapted before pointing it at the new channel.

## Implementation boundaries

1. **Feature parity:** port the reviewed setup-check implementation and its tests to Community, retaining maintenance-gated hardware access. Update Pro's pinned core after Community CI passes. Check the legacy main delta again immediately before cutover so later changes cannot silently disappear.
2. **Native candidate packaging:** add isolated staging to each GitHub repository. Package compiled runtime, dashboard, vendored scrcpy, bundled clients, production dependencies, required workspace targets and distribution notices. Include edition, source revisions, release version, target OS/architecture and required Node version in metadata. Keep `dist/index.js` compatible with the existing systemd unit. Do not mutate the development dependency installation when packaging.
3. **CI validation:** build the initial native target on Linux amd64, install production dependencies for that target, extract the archive into a clean directory and boot it through `dist/index.js`. Verify login, edition enforcement, assets and maintenance/restart behavior. Publish only ordinary private CI artifacts at this stage, not a production marker or public release. Other targets require their own validation before being advertised.
4. **Pro activation:** support supplying reviewed public verification keys at build time; reject private keys and reject production promotion with an empty trust store. Use test keys only in tests. Supply the real customer ID and entitlement separately through deployment configuration/private data. Test valid Pro, invalid/missing entitlement and expiry fallback without changing commercial terms.
5. **Release promotion and updater:** prepare explicit, separate Community/Pro native channels in the existing release storage. Use versioned artifact names and an edition/platform manifest with SHA-256 digest and source revisions. Upload/verify the bundle before updating the channel marker. Do not write the legacy `latest.json`. Publication, any new RBAC/infrastructure and promotion require approval; no additional paid services are proposed.
6. **Infrastructure changes:** in the existing IaC owner, configure the selected Pro channel, validate edition/platform/digest, reject unsafe archive paths, and update only while authenticated maintenance status is requested and ready. On errors defer. Preserve service configuration, DATA_DIR, entitlement and the prior release. Verify startup and keep maintenance enabled for explicit resume. Serialize updater executions. Do not infer readiness from a momentarily empty queue.

## First migration and rollback

The deployed legacy version has no maintenance toggle. Its first cutover therefore needs a coordinated intake pause, verified completion of running work, closed remote sessions and stopping the updater/service before backup. A transient empty-queue check alone is insufficient. Do not assume old transient queued uploads survive; let them finish before stopping.

Rehearse migration using a protected database/data copy and fake device operations. Keep copied credentials out of logs and prevent the rehearsal from sending notifications or touching physical devices. Verify users, organizations, device enrollment, history, artifact paths, setup checks, edition selection, valid entitlement and queued-job recovery. Select an enrolled fallback device without losing the pool configuration.

After approval, install the tested Pro bundle and required deployment configuration while retaining the current native/systemd installation layout. Enable and verify maintenance before reconnecting job intake, perform the approved physical-device checks, then explicitly resume. Record exact artifact digests and revisions.

Rollback restores the prior binary, updater configuration and matching pre-migration data backup with the service stopped. Do not promise that an older binary can safely read a newer database. Close the legacy backport and disable legacy release publication only once the new path is accepted; preserve the old artifact/backup for the agreed rollback window.

## Acceptance

- No ADO-only application features remain at cutover; two GitHub repositories are the sole application sources.
- Both native archives start without source checkout or development dependencies, enforce the correct edition, and preserve maintenance/queued inputs over restart.
- Pro can run the enrolled pool with the real reviewed entitlement; missing/invalid licensing remains fail-closed.
- An updater cannot confuse Community with Pro, install a wrong-platform/tampered archive, or restart active device work.
- A rehearsed backup/rollback restores the old installation; production changes and public publication remain separate approval steps.
- CI checks and PR policy evaluations finish green before implementation PRs are handed over.

## Workflow note

The workspace CLAUDE.md requires a reviewed written design before non-trivial implementation. Its referenced superpowers workflow skills were not available in the current skill catalog or local skill locations; this audit/design was prepared directly and does not claim that workflow was executed. Review this design before implementing release/updater changes.
