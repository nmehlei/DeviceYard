#!/usr/bin/env bash
# Assembles the Dockerfile.release build context from a native archive, so the Build stage
# (smoke-only, no credentials) and the Publish stage build the release image the same way.
# Usage: image-context.sh <archive.tar.gz> <context-dir>   (context-dir must not exist yet)
set -euo pipefail
if [ "$#" -ne 2 ]; then
  echo "Usage: image-context.sh <archive.tar.gz> <context-dir>" >&2
  exit 2
fi
archive="$1"
context="$2"
if [ -e "$context" ]; then
  echo "Image context directory already exists: $context" >&2
  exit 1
fi
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
container="$here/../container"
mkdir -p "$context/runtime" "$context/container"
tar -xzf "$archive" -C "$context/runtime"
cp "$container/entrypoint.sh" "$container/validate-config.cjs" "$container/notices.cjs" "$container/toolchain.json" "$context/container/"
