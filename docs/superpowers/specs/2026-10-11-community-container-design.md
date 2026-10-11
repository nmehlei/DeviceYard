# Community container distribution

## Outcome and scope

Package the existing Community application for a Linux host with USB-attached
Android devices. The image includes the server, static dashboard, CLI/MCP
assets, Maestro, Java, adb, tar, and the vendored scrcpy server. Preserve the
single-active-device policy. Pro remains private and EUR 99/year; this change
does not modify licensing, scheduling, production deployment, or Git history.

## Runtime design

Build from lockfiles in a multi-stage Dockerfile under ci/container. Use the
repository's Node 22 runtime requirement and the existing deployment's Maestro
2.6.1 initially; pin downloaded tooling by version and checksum. Validate the
Java runtime against that Maestro release during image construction. Start
with linux/amd64; publish other architectures only after their tooling and
runtime checks pass.

Run the application and ADB under the same non-root identity. Start ADB before
the Community entrypoint, forward termination to the application, and use an
init process to reap children. ADB listens on container loopback port 5037,
matching src/control/scrcpy.ts and CLI usage. Do not expose the ADB port.
Expose only the application HTTP port, with TLS supplied by the operator's
reverse proxy. Keep the existing required configuration variables.

Provide Linux Compose configuration with explicit USB bus access, USB device
cgroup permission, and host udev/group setup documented for the runtime user.
Do not require privileged mode. Persist DATA_DIR and the runtime user's ADB
identity in separate named volumes. Credentials are runtime configuration;
never copy local env files or ADB private keys into build layers. A connected
device is not required for server health, but hardware operations must report
unavailable or unauthorized devices through the existing behavior.

Keeping ADB on the host would require shared host networking or endpoint
changes across adb, Maestro and scrcpy. A sidecar adds lifecycle complexity.
An in-container daemon preserves the existing localhost assumptions and is
the selected first-release approach.

## Contents and publication

Use an explicit runtime file list: compiled application/assets, production
dependencies, tooling and applicable licenses/notices. Exclude test APKs,
test code, development dependencies, private configuration and Git metadata.
Generate a Linux dependency inventory during the build; retain notices for
the actual bundled dashboard and CLI/MCP dependencies as well as server
dependencies. Inventory Java/Maestro/ADB and base-image components separately.

The intended destination is ghcr.io/nmehlei/deviceyard with versioned tags
and source-revision labels. Prepare build and validation first. Registry
credentials, public repository visibility, release creation, and registry
publication require a separate exact-release approval. CI must not publish
from PR builds. Do not add paid runners or registry plans without approval.

The unresolved Selendroid fixture provenance remains a source-publication
finding. Excluding fixtures from the runtime image does not settle source
history attribution. Preserve that finding explicitly; do not rewrite shared
history or assert a completed audit.

## Acceptance

1. Build image locally and on isolated Linux CI from a clean checkout.
2. Verify tooling versions, required assets, non-root runtime and Community
   edition identity; prove a restart preserves database state and ADB identity.
3. Check missing configuration fails without logging credential values and
   termination stops the application and child processes cleanly.
4. On a dedicated Linux USB host, verify discovery, authorization, unplug/replug,
   APK install, a Maestro flow, screenshots and scrcpy control. Do not install
   apps or interrupt work on an occupied phone without authorization.
5. Inspect final image contents and notices before presenting a release for
   publication. Docker Desktop startup checks do not substitute for Linux USB
   hardware validation.

References: existing README.md and docs/guide/operating.md; ci/build.cjs;
src/control/scrcpy.ts; NME-IaC mobile-device-farm Ansible deployment;
https://docs.docker.com/reference/compose-file/services/.
