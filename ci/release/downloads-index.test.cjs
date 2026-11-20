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
    sumsUrl:`${BASE}/${version}/SHA256SUMS`,
  };
}
function withoutImage(version, sha256) {
  const {image, ...rest} = entry(version, sha256);
  return rest;
}

test('requires the SHA256SUMS link inside the release folder', () => {
  const good = entry('0.1.12');
  for (const change of [{sumsUrl:undefined}, {sumsUrl:`${BASE}/0.1.11/SHA256SUMS`}, {sumsUrl:`${BASE}/0.1.12/sums.txt`},
    {sumsUrl:'https://evil.example/SHA256SUMS'}]) {
    assert.throws(() => addRelease(null, {...good, ...change}), /entry/i, JSON.stringify(change));
  }
});

test('image is optional, and when set it is the release\'s own Pro tag', () => {
  assert.equal('image' in addRelease(null, withoutImage('0.1.12')).releases[0], false);
  for (const image of ['ghcr.io/nmehlei/deviceyard-pro:0.1.11', 'ghcr.io/someone/else:0.1.12', '']) {
    assert.throws(() => addRelease(null, {...entry('0.1.12'), image}), /entry/i, image);
  }
});

test('adds the image to a published version once it is public, and changes nothing else', () => {
  const index = addRelease(null, withoutImage('0.1.12'));
  const result = addRelease(index, {...entry('0.1.12'), date:'2026-12-01', notes:['Other.']});
  assert.deepEqual(result.releases, [{...withoutImage('0.1.12'), image:'ghcr.io/nmehlei/deviceyard-pro:0.1.12'}]);
  assert.equal('image' in index.releases[0], false);
});

test('rejects impossible dates and archive names other than the release archive', () => {
  for (const change of [{date:'2026-02-29'}, {date:'2026-99-99'}]) {
    assert.throws(() => addRelease(null, {...entry('0.1.12'), ...change}), /entry/i, JSON.stringify(change));
  }
  assert.equal(addRelease(null, {...entry('0.1.12'), date:'2028-02-29'}).releases[0].date, '2028-02-29');
  const file = 'other.tar.gz';
  assert.throws(() => addRelease(null, {...entry('0.1.12'), archive:{...entry('0.1.12').archive, file, url:`${BASE}/0.1.12/${file}`}}), /entry/i);
});

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

test('rejects an index that already lists a version twice', () => {
  const index = {schemaVersion:1, releases:[entry('0.1.12'), entry('0.1.12', 'b'.repeat(64))]};
  assert.throws(() => addRelease(index, entry('0.1.13')), /index/i);
});

test('accepts only URLs under the download base and the entry version', () => {
  const good = entry('0.1.12');
  const variants = [
    {archive:{...good.archive, url:'https://evil.example/pro/0.1.12/x.tar.gz'}},
    {archive:{...good.archive, url:`http://deviceyarddownloads.blob.core.windows.net/pro/0.1.12/${good.archive.file}`}},
    {archive:{...good.archive, url:`https://user@deviceyarddownloads.blob.core.windows.net/pro/0.1.12/${good.archive.file}`}},
    {archive:{...good.archive, url:`${BASE}/0.1.11/${good.archive.file}`}},
    {archive:{...good.archive, file:'../x.tar.gz'}},
    {manifestUrl:`${BASE}/0.1.11/manifest.json`},
    {licenseUrl:'https://deviceyarddownloads.blob.core.windows.net.evil.example/pro/0.1.12/PRO-LICENSE'},
  ];
  for (const change of variants) assert.throws(() => addRelease(null, {...good, ...change}), /entry/i, JSON.stringify(change));
  const other = 'https://downloads.example.test/pro';
  assert.equal(addRelease(null, JSON.parse(JSON.stringify(good).replaceAll(BASE, other)), {baseUrl:other}).releases.length, 1);
});

test('rejects non-string versions, bad dates and oversized notes', () => {
  const good = entry('0.1.12');
  for (const change of [{version:['0.1.12']}, {coreVersion:[0, 1, 15]}, {date:'yesterday'}, {notes:Array(101).fill('x')},
    {notes:['x'.repeat(1001)]}, {version:'1234567890.0.0'}]) {
    assert.throws(() => addRelease(null, {...good, ...change}), /entry/i, JSON.stringify(change));
  }
});

test('stores only known fields and never shares or mutates the inputs', () => {
  const index = addRelease(null, entry('0.1.11'));
  const snapshot = JSON.stringify(index);
  const added = {...entry('0.1.12'), extra:'private'};
  const result = addRelease(index, added);
  assert.equal(JSON.stringify(index), snapshot);
  assert.equal('extra' in result.releases[0], false);
  result.releases[0].archive.size = 1;
  assert.equal(added.archive.size, 13662965);
  assert.notEqual(addRelease(result, entry('0.1.12')), result);
});
