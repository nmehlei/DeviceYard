# Community Container Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Produce and validate a Community Linux container ready for a separately approved public release.

**Architecture:** Multi-stage build with an explicit runtime file list. The non-root application and ADB share the container network namespace; separate volumes preserve application data and ADB identity. Azure validates the image without publishing it.

**Tech Stack:** Node 22, npm lockfiles, Docker/Compose, Maestro 2.6.1, Java, Android platform tools, Azure Pipelines.

**Spec:** `docs/superpowers/specs/2026-10-11-community-container-design.md` (approved).

## Global Constraints

- First target: linux/amd64; Node 22; Maestro 2.6.1.
- Community retains one active device; Pro remains private and EUR 99/year.
- ADB uses container loopback port 5037; never publish that port.
- Non-root runtime, explicit USB access, no privileged mode.
- Preserve DATA_DIR and ADB identity across recreation; supply secrets only at runtime.
- No history rewrite, production deployment, registry push, release creation, or source-visibility change.
- No emulator startup. Hardware validation requires an available, authorized physical Linux USB setup.
- Keep unresolved fixture provenance recorded; image exclusion does not resolve source-history attribution.

## Review Focus

- Fresh volumes must be writable by the non-root runtime without recursively changing arbitrary host paths (Task 2).
- An unauthorized or absent phone must not make dashboard health fail (Tasks 2 and 4).
- Stop/recreate must preserve database contents and ADB identity and leave no runner processes (Task 2).
- A failed config check must not print credentials, even when collecting CI diagnostics (Task 2).
- USB unplug/replug must work despite changing bus device numbers and supplementary groups (Tasks 3 and 4).

### Task 1: Build the complete runtime image

**Files:** create `.dockerignore`, `ci/container/Dockerfile`, `ci/container/toolchain.json`, `ci/container/notices.cjs`; use `ci/build.cjs` and `ci/notices.cjs`.

**Interfaces:** `docker build --platform linux/amd64 -f ci/container/Dockerfile -t deviceyard-community:test .` produces a local image. Toolchain metadata records downloaded versions, URLs and SHA-256 values; image labels record source revision and AGPL-3.0-only.

- [ ] Resolve the Node base digest and Maestro 2.6.1 archive/checksum from official upstream sources; record them in toolchain metadata. Select and record a compatible Java runtime by verifying `maestro --version` in the target Linux environment.
- [ ] Create a multi-stage image: lockfile installs, existing webpack build, separate production dependency install, and explicit runtime copies. Retain server/dashboard/CLI/MCP/scrcpy assets and licenses. Use a fixed non-root UID/GID 1000 and owned `/data` and `/home/deviceyard/.android` directories.
- [ ] Add a default-deny build context allowlist for required source, manifests, lockfiles, CI build helpers and licenses. Exclude `.git`, env files, node_modules, tests/APKs, prebuilt output and unrelated local files.
- [ ] Generate the Linux dependency inventory before discarding build dependencies, retain bundled-code notices, and inventory OS/Java/ADB/Maestro licenses under `/opt/deviceyard/notices`. Record unresolved notices explicitly; do not present inventory generation as legal clearance.
- [ ] Build the image. Verify Node/Java/adb/Maestro versions, required assets and a non-zero runtime UID; inspect the final filesystem for excluded inputs. Fail if required tooling cannot execute on linux/amd64.
- [ ] Commit the verified build and inventory changes.

### Task 2: Lifecycle and persistent-state validation

**Files:** create `ci/container/entrypoint.sh`, `ci/container/smoke.cjs`; update `ci/container/Dockerfile`.

**Interfaces:** entrypoint starts local ADB, then runs `node /opt/deviceyard/dist/entry.js` under an init process. `node ci/container/smoke.cjs deviceyard-community:test` exits zero only after lifecycle checks pass and removes only its uniquely named containers/volumes.

- [ ] Write the smoke harness using generated disposable credentials held in memory or a mode-0600 temporary env file. Never print Docker inspect environment fields, raw application logs or generated credentials. Publish HTTP on a randomly assigned loopback host port.
- [ ] Assert fresh-volume startup, `/login` HTTP 200, authenticated `/api/edition` reporting `community` and `multiDevice: false`, and healthy startup without a phone. Run against the incomplete image to establish the missing-lifecycle failure.
- [ ] Implement the entrypoint and init configuration. Start ADB as the application user; ensure Node receives SIGTERM and container exit is bounded. Keep default command overridable for diagnostics.
- [ ] Extend smoke checks to recreate the container with the same volumes and verify login/database persistence and the unchanged SHA-256 of its ADB public identity (never print private keys). Assert container stop completes without forced termination.
- [ ] Add missing-required-config checks that assert nonzero exit and no sentinel credential value in captured output; print only sanitized assertion failures.
- [ ] Run the smoke harness against the built image and inspect its cleanup behavior. Commit after it passes.

### Task 3: Linux USB installation and CI validation

**Files:** create `ci/container/compose.yaml`, `docs/guide/container.md`; update `README.md`, `ci/azure-pipelines.yml`.

**Interfaces:** Compose builds/uses the tested image, mounts application and ADB volumes, binds `/dev/bus/usb`, permits USB character-device major 189 through `device_cgroup_rules`, and adds the operator-specified USB group GID. Required runtime variables are supplied externally.

- [ ] Document host udev rules and supplementary group setup, device authorization, durable-volume backup, stable encryption-key configuration, startup and upgrade/rollback commands. Explain Linux USB support and why Docker Desktop is not hardware acceptance evidence.
- [ ] Add Compose configuration with no privileged mode, no published ADB port, and HTTP bound to loopback by default. Validate syntax with `docker compose -f ci/container/compose.yaml config --quiet` using disposable input values, without printing resolved configuration.
- [ ] Add image build and smoke validation after existing Azure tests/build checks on isolated hosted Linux. Keep PR builds credential-free. Use no push/login command and do not create a separate pipeline run manually.
- [ ] Update README with the installation-guide link and current release-candidate status. Commit these changes.
- [ ] Push the feature branch and create a PR in the owned repository. Monitor the automatic validation through completion; fix any failure and recheck the current PR head before handoff.

### Task 4: Hardware and release evidence

**Files:** create `docs/releases/community-container-validation.md`; update `docs/licenses/publication-audit.md` only with verified findings.

**Interfaces:** A dated evidence record names the image digest, source commit, Linux host/toolchain versions and each acceptance result without credentials or private host configuration.

- [ ] Identify an authorized, idle physical Linux USB target from the existing infrastructure. If unavailable, mark hardware validation pending and ask for access/coordination; do not start an emulator or interrupt a shared phone.
- [ ] Verify USB discovery/authorization, unplug/replug, APK installation and one harmless Maestro flow on that target; verify screenshot and scrcpy control. Confirm the Community scheduler admits only its selected active device.
- [ ] Inspect the final image content and notice inventory, documenting unresolved attribution independently from successful runtime checks. Preserve the existing source history.
- [ ] Record test results and remaining publication conditions. Prepare the exact proposed GHCR name/tag/digest and matching source revision for approval; do not publish or create a release draft.

## Execution recommendation

Use native execution in this session: the image, lifecycle harness and Compose setup are tightly coupled. Finish with an independent whole-branch review and current green CI before handoff. Public release remains a separate decision after hardware and attribution evidence is available.
