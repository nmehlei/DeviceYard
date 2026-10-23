const path = require('node:path');
const fs = require('node:fs');

function nativeVersion({mode, version, buildId, reason, branch}) {
  if (typeof version !== 'string' || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) {
    throw Error('Community package must declare a stable semantic version');
  }
  if (mode === 'candidate') {
    if (!/^[1-9][0-9]*$/.test(buildId || '')) throw Error('Invalid build ID');
    return `${version}-ci.${buildId}`;
  }
  if (mode !== 'stable' || reason !== 'Manual' || branch !== 'refs/heads/main') {
    throw Error('Stable packaging requires a manual main build');
  }
  return version;
}
module.exports = {nativeVersion};
if (require.main === module) {
  try {
    // Relative to this file, including when invoked from Pro's pinned core.
    const {version:baseVersion} = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
    const version = nativeVersion({mode:process.env.NATIVE_RELEASE_MODE, version:baseVersion,
      buildId:process.env.BUILD_BUILDID, reason:process.env.BUILD_REASON, branch:process.env.BUILD_SOURCEBRANCH});
    console.log(`##vso[task.setvariable variable=nativeVersion]${version}`);
    console.log(`Shared native version: ${version}; promotion remains separate`);
  } catch {
    console.error('Native version rejected; use candidate, or stable in a manual main build with a valid Community version');
    process.exitCode = 1;
  }
}
