const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {runtimePackage} = require('./package.cjs');
const {smoke} = require('./smoke.cjs');
const {approvedManifest} = require('./promote.cjs');
const {createHash} = require('node:crypto');

test('standalone dependency manifest removes source workspace links without changing runtime versions or the source lock', () => {
  const root = path.resolve(__dirname, '../..');
  const before = fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8');
  const original = JSON.parse(before);
  const {pkg, lock} = runtimePackage(root);
  assert.equal(pkg.workspaces, undefined);
  assert.equal(lock.packages['node_modules/@deviceyard/shared'], undefined);
  assert.equal(lock.packages['node_modules/@deviceyard/cli'], undefined);
  assert.deepEqual(lock.packages['node_modules/express'], original.packages['node_modules/express']);
  assert.equal(pkg.scripts.start, 'node dist/index.js');
  assert.equal(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'), before);
});

test('archive smoke refuses a tampered bundle before extracting or starting anything', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-integrity-'));
  try {
    const blob = 'deviceyard-community-0.0.0-test-linux-x64.tar.gz';
    fs.writeFileSync(path.join(root, blob), 'tampered');
    const manifest = path.join(root, 'release.json');
    fs.writeFileSync(manifest, JSON.stringify({blob, sha256:'0'.repeat(64)}));
    await assert.rejects(smoke(manifest), /checksum mismatch/);
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
});

test('promotion cannot activate an empty or unreviewed Pro trust store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-promotion-'));
  try {
    const archive = path.join(dir, 'candidate'); fs.writeFileSync(archive, 'candidate');
    const candidate = {schemaVersion:1, edition:'pro', version:'0.0.0-test', platform:'linux-x64', node:'>=22.13.0',
      blob:'deviceyard-pro-0.0.0-test-linux-x64.tar.gz', entrypoint:'dist/index.js', revisions:{core:'a'.repeat(40), pro:'b'.repeat(40)},
      sha256:createHash('sha256').update('candidate').digest('hex'), trustedKeyIds:[], productionReady:false};
    assert.throws(() => approvedManifest(candidate, archive), /reviewed verification/);
    candidate.trustedKeyIds = ['reviewed-key'];
    assert.throws(() => approvedManifest(candidate, archive, ['other-key']), /reviewed verification/);
    assert.equal(approvedManifest(candidate, archive, ['reviewed-key']).productionReady, true);
    assert.equal(candidate.productionReady, false);
    fs.writeFileSync(archive, 'modified');
    assert.throws(() => approvedManifest(candidate, archive, ['reviewed-key']), /checksum mismatch/);
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});
