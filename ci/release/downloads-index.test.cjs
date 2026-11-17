const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {addRelease} = require('./downloads-index.cjs');

const BASE = 'https://deviceyarddownloads.blob.core.windows.net/pro';
function entry(version, sha256 = 'a'.repeat(64)) {
  const file = `deviceyard-pro-${version}-linux-x64.tar.gz`;
  return {
    version, date:'2026-11-18', notes:['Faster device sync.'], coreVersion:'0.1.15',
    image:`ghcr.io/nmehlei/deviceyard-pro:${version}`,
    archive:{file, url:`${BASE}/${version}/${file}`, size:13662965, sha256},
    manifestUrl:`${BASE}/${version}/${file}.json`, licenseUrl:`${BASE}/${version}/PRO-LICENSE`,
  };
}

test('adds the first release to an empty index', () => {
  assert.deepEqual(addRelease(null, entry('0.1.12')), {schemaVersion:1, releases:[entry('0.1.12')]});
  assert.deepEqual(addRelease({schemaVersion:1, releases:[]}, entry('0.1.12')), {schemaVersion:1, releases:[entry('0.1.12')]});
});

test('keeps releases sorted newest first by semver, not by string (1.10.0 before 1.9.0)', () => {
  let index = null;
  for (const v of ['1.9.0', '1.10.0', '0.2.0', '1.9.1']) index = addRelease(index, entry(v));
  assert.deepEqual(index.releases.map((r) => r.version), ['1.10.0', '1.9.1', '1.9.0', '0.2.0']);
});

test('returns the index unchanged for the same version and sha256', () => {
  const index = addRelease(addRelease(null, entry('0.1.11')), entry('0.1.12'));
  const before = JSON.stringify(index);
  const again = addRelease(index, {...entry('0.1.12'), date:'2026-12-01'});
  assert.equal(JSON.stringify(again), before);
});

test('rejects a duplicate version with a different sha256', () => {
  const index = addRelease(null, entry('0.1.12'));
  const before = JSON.stringify(index);
  assert.throws(() => addRelease(index, entry('0.1.12', 'b'.repeat(64))), /Version 0\.1\.12 already published with different contents/);
  assert.equal(JSON.stringify(index), before);
});

test('rejects a malformed index', () => {
  for (const bad of [{}, {schemaVersion:2, releases:[]}, {schemaVersion:1}, {schemaVersion:1, releases:{}},
    {schemaVersion:1, releases:[{version:'x'}]}, [], 'index']) {
    assert.throws(() => addRelease(bad, entry('0.1.12')), /index/i, JSON.stringify(bad));
  }
});

test('rejects a malformed entry', () => {
  assert.throws(() => addRelease(null, {...entry('0.1.12'), version:'0.1.12-ci.7'}));
  assert.throws(() => addRelease(null, {...entry('0.1.12'), archive:{...entry('0.1.12').archive, sha256:'xyz'}}));
});

test('CLI adds an entry to an index file or to a missing index', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'downloads-index-'));
  const cli = path.join(__dirname, 'downloads-index.cjs');
  try {
    const e = path.join(dir, 'entry.json');
    const out = path.join(dir, 'out.json');
    fs.writeFileSync(e, JSON.stringify(entry('0.1.12')));
    execFileSync(process.execPath, [cli, 'add', '-', e, out], {stdio:'pipe'});
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')).releases.map((r) => r.version), ['0.1.12']);
    fs.writeFileSync(e, JSON.stringify(entry('0.1.12', 'c'.repeat(64))));
    assert.throws(() => execFileSync(process.execPath, [cli, 'add', out, e, path.join(dir, 'x.json')], {stdio:'pipe', encoding:'utf8'}),
      (err) => err.status === 1 && /different contents/.test(err.stderr));
    assert.equal(fs.existsSync(path.join(dir, 'x.json')), false);
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});
