# Release readiness

## Agreed deployment and documentation scope

Offer native installation and Docker on Linux for both Community and Pro.
Deployment method does not change edition limits: Community supports one active
device; Pro adds multi-device operation at EUR 99 per organization per year.

Native/systemd is the recommended deployment for USB-connected Linux farms.
Keep the existing production farm on its native deployment. Docker is an
optional deployment path, experimental until physical-device acceptance passes.
The existing container work covers Community; Pro packaging still needs its own
implementation and validation. Do not advertise a Pro image as available yet.

Maintenance mode remains planned for both deployment methods and editions:
stop starting jobs, allow running jobs to finish, preserve the queue, and resume
explicitly. See the [maintenance design](../superpowers/specs/2026-10-11-maintenance-mode-design.md).

## Website guides: required for the initial public release

Publish guides on the DeviceYard website, with a visible link from the homepage
and navigation. Keep guide content version-controlled with the code and publish
the release-matched content to the website; avoid maintaining a separate copy
of installation instructions in the homepage repository.

- Getting started: edition choice, prerequisites, and completing a first job.
- Installation: native/systemd and Docker on Linux, recommendation, supported
  platforms, and each path's actual validation status. Explain that Docker
  Desktop is not equivalent to Linux USB device access.
- Operations: device setup, maintenance mode when shipped, upgrades, backups,
  recovery, and troubleshooting.

Before publishing, verify commands against the corresponding released edition
and deployment method, check internal links, and ensure planned features and
unpublished images are not described as available. Website publication and
content integration are still pending; this document records scope only.

## Remaining release work

- Implement and validate maintenance mode in Community, Pro, and the native
  production code path before deploying it to the farm.
- Complete the website guide integration described above.
- Finish [source and redistribution checks](../licenses/publication-audit.md).
- Complete [container hardware validation](community-container-validation.md)
  before promoting Docker from experimental to supported.
- Obtain explicit approval for public repository/image publication. Native
  source release need not wait for Docker to become the recommended deployment.
