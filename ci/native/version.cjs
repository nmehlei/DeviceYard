const {gitVersion} = require('./git-version.cjs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

function nativeVersion({mode, version, buildId, reason, branch}) {
  if (typeof version !== 'string' || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) {
    throw Error('GitVersion must produce a stable semantic version');
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
    if (process.env.NATIVE_RELEASE_MODE === 'stable') {
      // In Pro, a main build must also pin a merged Community revision.
      execFileSync('git',['merge-base','--is-ancestor','HEAD','refs/remotes/origin/main'],
        {cwd:path.resolve(__dirname,'../..'),stdio:'pipe'});
    }
    const baseVersion = gitVersion();
    const version = nativeVersion({mode:process.env.NATIVE_RELEASE_MODE, version:baseVersion,
      buildId:process.env.BUILD_BUILDID, reason:process.env.BUILD_REASON, branch:process.env.BUILD_SOURCEBRANCH});
    console.log(`##vso[task.setvariable variable=nativeVersion]${version}`);
    console.log(`Shared native version: ${version}; promotion remains separate`);
  } catch {
    console.error('Native version rejected; verify full Community history, restored GitVersion 5.12.0 and packaging mode');
    process.exitCode = 1;
  }
}
