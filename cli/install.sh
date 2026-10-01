#!/bin/sh
# DeviceYard CLI installer.
#
# Resolves the platform binary straight from the public npm registry, so this
# script needs no artifact host of its own and any farm can serve it.
#
#   curl -fsSL https://your-farm/cli/install.sh | sh
#
# Environment:
#   DEVICEYARD_PREFIX    install root (default $HOME/.deviceyard)
#   DEVICEYARD_VERSION   version to install (default latest)
#   DEVICEYARD_REGISTRY  npm registry (default https://registry.npmjs.org)
set -eu

REGISTRY="${DEVICEYARD_REGISTRY:-https://registry.npmjs.org}"
PREFIX="${DEVICEYARD_PREFIX:-$HOME/.deviceyard}"
VERSION="${DEVICEYARD_VERSION:-latest}"

for tool in curl tar; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "deviceyard: $tool is required but not installed" >&2
    exit 1
  }
done

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$(uname -m)" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *) echo "deviceyard: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
case "${os}" in
  darwin|linux) ;;
  *) echo "deviceyard: unsupported OS ${os}" >&2; exit 1 ;;
esac

pkg="@deviceyard/cli-${os}-${arch}"
echo "deviceyard: resolving ${pkg}@${VERSION}" >&2

meta="$(curl -fsSL "${REGISTRY}/${pkg}/${VERSION}")" || {
  echo "deviceyard: could not fetch ${pkg}@${VERSION} from ${REGISTRY}." >&2
  echo "            Set DEVICEYARD_REGISTRY if you use a mirror." >&2
  exit 1
}

# No jq: a CI image is not guaranteed to have one, and requiring a JSON parser
# in order to install a CLI is exactly the dependency this script exists to
# avoid.
tarball="$(printf '%s' "${meta}" | sed -n 's/.*"tarball":"\([^"]*\)".*/\1/p' | head -1)"
[ -n "${tarball}" ] || {
  echo "deviceyard: no tarball URL in the registry response for ${pkg}" >&2
  exit 1
}

tmp="$(mktemp -d)"
# shellcheck disable=SC2064
trap "rm -rf '${tmp}'" EXIT INT TERM

curl -fsSL "${tarball}" -o "${tmp}/pkg.tgz"
tar -xzf "${tmp}/pkg.tgz" -C "${tmp}"

[ -f "${tmp}/package/bin/deviceyard" ] || {
  echo "deviceyard: the downloaded package did not contain bin/deviceyard" >&2
  exit 1
}

mkdir -p "${PREFIX}/bin"
# Move into place only after the download and unpack have both succeeded, so a
# failed upgrade leaves the working binary alone rather than a truncated one.
mv "${tmp}/package/bin/deviceyard" "${PREFIX}/bin/deviceyard"
chmod +x "${PREFIX}/bin/deviceyard"

echo "deviceyard: installed to ${PREFIX}/bin/deviceyard" >&2
"${PREFIX}/bin/deviceyard" --version >&2

case ":${PATH}:" in
  *":${PREFIX}/bin:"*) ;;
  *)
    echo "" >&2
    echo "Add it to your PATH:" >&2
    echo "  export PATH=\"${PREFIX}/bin:\$PATH\"" >&2
    ;;
esac
