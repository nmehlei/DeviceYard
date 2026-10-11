# Community container validation

Release candidate; not published. Initial validation on 2026-10-11.

## Automated checks

The local linux/amd64 build uses the Node base digest and Maestro archive
checksum in `ci/container/toolchain.json`. Its checked runtime versions are
Node 22.23.3, OpenJDK 17.0.20.1, Debian adb 1:29.0.6-28 (ADB protocol 1.0.41),
Maestro 2.6.1, and tini 0.19.0-1+b3. Debian updates may change package versions
on a later build; every image records its actual installed package inventory.

`ci/container/smoke.cjs` checks a non-root runtime, required assets/tooling,
Community edition identity, HTTP health without a phone, startup with all
capabilities dropped, durable login and ADB identity across recreation,
graceful stop, and credential-safe errors for missing and malformed config.
The harness uses disposable data and never attaches a physical phone.

Compose syntax validation uses `config --quiet`; it does not print resolved
runtime credentials. Public-registry publishing is not part of the pipeline.

## Physical-device check: pending

Read-only SSH access was subsequently established using the configured farm
endpoint and existing SSH identity. The farm runs a native systemd service;
Docker was not found on the host. Production stays native, as recorded in
[release readiness](release-readiness.md). No host services were changed and
no phone was used. An authorized device test window and a prepared Linux Docker
host are still required before running the hardware acceptance checks:

- discovery and USB debugging authorization;
- unplug/replug without changing container configuration;
- APK installation and a harmless Maestro flow;
- screenshots and scrcpy control;
- Community single-active-device behavior.

Docker Desktop success is not Linux USB acceptance. Existing production farm
services and shared phones must not be interrupted to perform these checks.

## Public-release conditions

- Complete physical-device checks on the final candidate image.
- Complete the source and redistribution findings in
  `docs/licenses/publication-audit.md`, including the retained Selendroid
  snapshot and applicable notices/source correspondence for bundled tooling.
- Record the exact final image digest and matching source revision, then obtain
  publication approval. No digest in this development record authorizes a push.
