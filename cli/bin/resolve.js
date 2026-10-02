// Plain CommonJS, no build step: this file runs from the published tarball on
// a user's machine, before anything of ours has been compiled there.
const SUPPORTED = {
  "darwin-arm64": true,
  "darwin-x64": true,
  "linux-x64": true,
  "linux-arm64": true,
};

function resolveBinary(platform, arch, resolver) {
  const key = `${platform}-${arch}`;

  if (!SUPPORTED[key]) {
    throw new Error(
      `deviceyard: ${key} is not supported. Supported: ${Object.keys(SUPPORTED).join(", ")}.\n` +
      `On another platform, use the curl installer or run from source:\n` +
      `  curl -fsSL https://your-farm/cli/install.sh | sh`,
    );
  }

  const pkg = `@deviceyard/cli-${key}`;
  try {
    return { pkg, binary: resolver(`${pkg}/bin/deviceyard`) };
  } catch {
    // npm skips an optionalDependency it cannot install, SILENTLY. Naming the
    // package and the reinstall flag is the only way a user finds out why the
    // command they just installed does not work.
    throw new Error(
      `deviceyard: the platform binary ${pkg} is not installed.\n` +
      `Reinstall with optional dependencies enabled:\n` +
      `  npm install -g @deviceyard/cli --include=optional`,
    );
  }
}

module.exports = { resolveBinary, SUPPORTED };
