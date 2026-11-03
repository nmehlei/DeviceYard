# Publishing releases (maintainers)

Every merge to `main` publishes a Community release: the `Publish` stage of
`ci/azure-pipelines.yml` pushes the image to `ghcr.io/nmehlei/deviceyard` and
creates the GitHub release on `nmehlei/DeviceYard` with the native archive.
Contributors need none of this; it is the repository owner's setup.

The pipeline file cannot enforce where its secrets are used. The protections
below are configured by the owner in Azure DevOps and GitHub, and they must be
in place **before** the pipeline change that references them is pushed.

## Variable group `deviceyard-publishing`

Create the variable group (Pipelines > Library) before pushing a pipeline
version that references it; a run against a missing group fails at queue time.
Store both values as secrets:

| Variable | Token | Scope |
| --- | --- | --- |
| `GITHUB_PUBLISH_TOKEN` | Fine-grained personal access token | Repositories `nmehlei/DeviceYard` and `nmehlei/DeviceYard-Pro`; Contents: read and write; Pull requests: read |
| `GHCR_PUSH_TOKEN` | Classic personal access token | `write:packages` only (fine-grained tokens cannot push to GHCR) |

The GHCR login uses the token owner's account as username (`nmehlei`); a token
from another account needs the username in the pipeline changed with it.

Give the pipeline access to the group (Pipeline permissions) and add these
checks to the group (Approvals and checks):

- **Branch control**: allowed branches `refs/heads/main` only, with "Verify
  branch protection" enabled. This keeps the secrets away from any run that is
  not on the protected `main` branch.
- **Exclusive lock**: only one run uses the group at a time. The pipeline sets
  `lockBehavior: sequential`, so later runs queue instead of being cancelled.
  The `Publish` job relies on this: it computes the floating image tags
  (`<major>.<minor>`, `<major>`, `latest`) from the tags in its own checkout,
  which are current only if no other publish runs concurrently.

## Pipeline settings

In the pipeline's pull-request validation settings for GitHub, keep **"Make
secrets available to builds of forks"** turned off. Pull-request and fork builds
only run the `Build` stage, which never references the group; this setting is a
second line of defence.

## First publication

After the first successful push, GHCR creates the `deviceyard` package as
private. Set its visibility to **public** (GitHub > Packages > deviceyard >
Package settings), otherwise `docker pull` requires authentication.

## Re-runs

Re-running a run whose version is already published is a no-op. If the image
exists but the release does not, a re-run publishes only the release. A
published release without its image stops the run for an operator decision.
A manual run of a `main` commit that has not been published yet publishes it,
like any merge would.
