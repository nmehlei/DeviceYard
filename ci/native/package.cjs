#!/usr/bin/env node
// Native candidates only. This script never uploads or updates a release channel.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');

function runtimePackage(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
  // Runtime imports are compiled relative imports/bundles. Source workspaces
  // are development-only; do not ship dangling links to TypeScript sources.
  delete pkg.workspaces;
  delete lock.packages[''].workspaces;
  for (const key of Object.keys(lock.packages)) {
    if (['shared', 'cli', 'node_modules/@deviceyard/shared', 'node_modules/@deviceyard/cli'].includes(key)) delete lock.packages[key];
  }
  pkg.scripts = {start: 'node dist/index.js'};
  return {pkg, lock};
}

function packageNative({root, coreRoot = root, edition = 'community', entry = 'entry.js', version, output, revisions, trustedKeyIds = []}) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw Error('Native candidates currently require a Linux x64 builder');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version || '')) throw Error('Invalid release version');
  if (!['community', 'pro'].includes(edition)) throw Error('Invalid edition');
  if (!revisions || !Object.values(revisions).every(value => /^[a-f0-9]{40}$/.test(value))) throw Error('Full source revisions required');
  if (!['entry.js', 'src/entry.js'].includes(entry)) throw Error('Invalid edition entrypoint');
  root = path.resolve(root); output = path.resolve(output);
  fs.mkdirSync(output, {recursive:true});
  const archiveName = `deviceyard-${edition}-${version}-linux-x64.tar.gz`;
  const archive = path.join(output, archiveName);
  const manifestPath = path.join(output, archiveName + '.json');
  if (fs.existsSync(archive) || fs.existsSync(manifestPath)) throw Error('Refusing to overwrite a native candidate');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deviceyard-native-'));
  try {
    const stage = path.join(temp, 'runtime'); fs.mkdirSync(stage);
    fs.cpSync(path.join(root, 'dist'), path.join(stage, 'dist'), {recursive:true});
    if (!fs.statSync(path.join(stage, 'dist', entry)).size) throw Error('Missing compiled edition entrypoint');
    fs.writeFileSync(path.join(stage, 'dist/index.js'), `require(${JSON.stringify('./' + entry)});\n`);
    const {pkg, lock} = runtimePackage(root);
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    fs.writeFileSync(path.join(stage, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
    // Never run dependency lifecycle scripts with release credentials in scope.
    execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd:stage, stdio:'pipe', env:{PATH:process.env.PATH, HOME:temp, npm_config_cache:path.join(temp, 'npm-cache')},
    });
    fs.mkdirSync(path.join(stage, 'notices'));
    for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(coreRoot, file), path.join(stage, 'notices', file));
    const noticeFile = path.join(coreRoot, 'docs/licenses/dependencies.json');
    if (!fs.statSync(noticeFile).size) throw Error('Generate release-platform dependency notices before packaging');
    fs.copyFileSync(noticeFile, path.join(stage, 'notices/dependencies.json'));
    if (edition === 'pro') fs.copyFileSync(path.join(root, 'PRO-LICENSE'), path.join(stage, 'PRO-LICENSE'));
    const info = `version=${version}\nedition=${edition}\nplatform=linux-x64\n${Object.entries(revisions).map(([k,v]) => `${k}=${v}`).join('\n')}\n`;
    fs.writeFileSync(path.join(stage, 'BUILD_INFO'), info);
    fs.writeFileSync(path.join(stage, 'dist/BUILD_INFO'), info);
    const metadata = {schemaVersion:1, edition, version, platform:'linux-x64', node:pkg.engines.node,
      revisions, trustedKeyIds, productionReady:false, entrypoint:'dist/index.js'};
    fs.writeFileSync(path.join(stage, 'release.json'), JSON.stringify(metadata, null, 2) + '\n');
    execFileSync('tar', ['-czf', path.join(temp, archiveName), '-C', stage, '.']);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(temp, archiveName))).digest('hex');
    fs.copyFileSync(path.join(temp, archiveName), archive, fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(manifestPath, JSON.stringify({...metadata, blob:archiveName, sha256}, null, 2) + '\n', {flag:'wx'});
    console.log(`Packaged ${archiveName}; candidate only, no publication`);
    return manifestPath;
  } finally { fs.rmSync(temp, {recursive:true, force:true}); }
}
module.exports = {packageNative, runtimePackage};
if (require.main === module) {
  try {
    const root = path.resolve(__dirname, '../..');
    const commit = process.env.SOURCE_REVISION || execFileSync('git', ['rev-parse', 'HEAD'], {cwd:root, encoding:'utf8'}).trim();
    packageNative({root, output:process.argv[2], version:process.argv[3], revisions:{core:commit}});
  } catch { console.error('Native packaging failed; dependency output withheld to protect build credentials'); process.exitCode = 1; }
}
