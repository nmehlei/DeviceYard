const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {imageTags, publishRelease, sha256sums} = require('./publish.cjs');

const TOKEN = 'ghp_SECRETTOKENVALUE123';
const REV = 'a'.repeat(40);
process.env.SOURCE_REVISION = REV;

function workdir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deviceyard-publish-test-'));
  const paths = Object.entries(files).map(([name, content]) => { const p = path.join(dir, name); fs.writeFileSync(p, content); return p; });
  return {dir, paths, cleanup: () => fs.rmSync(dir, {recursive: true, force: true})};
}
const json = (status, body) => ({ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => Buffer.from(JSON.stringify(body))});
const text = (status, body) => ({ok: status >= 200 && status < 300, status, text: async () => body, json: async () => { throw Error('not json'); }});

// Fake GitHub: `existing` is a release object (or null) returned by the tag lookup.
function fakeGithub({existing = null, sums = '', createStatus = 201} = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url); const method = init.method || 'GET';
    calls.push({url: String(url), method, headers: init.headers || {}, body: init.body});
    if (method === 'GET' && u.pathname.startsWith('/repos/o/r/releases/tags/')) return existing ? json(200, existing) : json(404, {message: 'Not Found'});
    if (method === 'GET' && u.pathname.startsWith('/repos/o/r/releases/assets/')) return text(200, sums);
    if (method === 'POST' && u.pathname === '/repos/o/r/releases') return createStatus === 201 ? json(201, {id: 1, upload_url: 'https://uploads.github.com/repos/o/r/releases/1/assets{?name,label}'}) : json(createStatus, {message: TOKEN + ' leaked body'});
    if (method === 'POST' && u.pathname === '/repos/o/r/releases/1/assets') return json(201, {id: 9});
    return json(500, {message: 'unexpected ' + method + ' ' + url});
  };
  return {calls, fetchImpl};
}

test('imageTags returns version, minor, major and latest', () => {
  assert.deepEqual(imageTags('ghcr.io/nmehlei/deviceyard', '1.2.3'), ['ghcr.io/nmehlei/deviceyard:1.2.3', 'ghcr.io/nmehlei/deviceyard:1.2', 'ghcr.io/nmehlei/deviceyard:1', 'ghcr.io/nmehlei/deviceyard:latest']);
  assert.throws(() => imageTags('ghcr.io/x/y', '1.2'), /Invalid version/);
});

test('sha256sums sorts by basename', () => {
  const w = workdir({'b.txt': 'b', 'a.txt': 'a'});
  try {
    const sha = c => createHash('sha256').update(c).digest('hex');
    assert.equal(sha256sums(w.paths), `${sha('a')}  a.txt\n${sha('b')}  b.txt\n`);
  } finally { w.cleanup(); }
});

test('publishRelease creates release and uploads every asset plus SHA256SUMS', async () => {
  const w = workdir({'one.tar.gz': 'ONE', 'two.json': '{"a":1}'});
  try {
    const gh = fakeGithub();
    const result = await publishRelease({repo: 'o/r', tag: 'v1.2.3', name: 'v1.2.3', notes: 'Hello', assets: w.paths, token: TOKEN, fetchImpl: gh.fetchImpl});
    assert.equal(result, 'created');
    const create = gh.calls.find(c => c.method === 'POST' && c.url.endsWith('/releases'));
    assert.deepEqual(JSON.parse(create.body), {tag_name: 'v1.2.3', name: 'v1.2.3', body: 'Hello', target_commitish: REV, draft: false, prerelease: false});
    assert.equal(create.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(create.headers.Accept, 'application/vnd.github+json');
    assert.equal(create.headers['X-GitHub-Api-Version'], '2022-11-28');
    const uploads = gh.calls.filter(c => c.url.includes('/assets?name='));
    assert.deepEqual(uploads.map(c => new URL(c.url).searchParams.get('name')).sort(), ['SHA256SUMS', 'one.tar.gz', 'two.json']);
    assert.ok(uploads.every(c => c.url.startsWith('https://uploads.github.com/repos/o/r/releases/1/assets?name=') && !c.url.includes('{')));
    for (const u of uploads) {
      assert.equal(u.headers['Content-Type'], 'application/octet-stream');
      assert.equal(u.headers['Content-Length'], String(u.body.length));
    }
    const sums = uploads.find(c => c.url.endsWith('name=SHA256SUMS'));
    assert.equal(sums.body.toString(), sha256sums(w.paths));
  } finally { w.cleanup(); }
});

test('publishRelease is a no-op for the same sha256', async () => {
  const w = workdir({'one.tar.gz': 'ONE'});
  try {
    const gh = fakeGithub({existing: {id: 1, assets: [{name: 'SHA256SUMS', url: 'https://api.github.com/repos/o/r/releases/assets/5'}]}, sums: sha256sums(w.paths)});
    assert.equal(await publishRelease({repo: 'o/r', tag: 'v1.2.3', name: 'v1.2.3', notes: 'x', assets: w.paths, token: TOKEN, fetchImpl: gh.fetchImpl}), 'unchanged');
    assert.ok(gh.calls.every(c => c.method === 'GET'));
    assert.equal(gh.calls.find(c => c.url.endsWith('/assets/5')).headers.Accept, 'application/octet-stream');
  } finally { w.cleanup(); }
});

test('publishRelease fails for an existing tag with different contents', async () => {
  const w = workdir({'one.tar.gz': 'ONE'});
  try {
    const gh = fakeGithub({existing: {id: 1, assets: [{name: 'SHA256SUMS', url: 'https://api.github.com/repos/o/r/releases/assets/5'}]}, sums: 'deadbeef  one.tar.gz\n'});
    await assert.rejects(publishRelease({repo: 'o/r', tag: 'v1.2.3', name: 'v1.2.3', notes: 'x', assets: w.paths, token: TOKEN, fetchImpl: gh.fetchImpl}), {message: 'Release v1.2.3 already exists with different contents'});
    assert.ok(gh.calls.every(c => c.method === 'GET'));
  } finally { w.cleanup(); }
});

test('publishRelease fails clearly when an existing release has no SHA256SUMS', async () => {
  const w = workdir({'one.tar.gz': 'ONE'});
  try {
    const gh = fakeGithub({existing: {id: 1, assets: [{name: 'one.tar.gz', url: 'https://api.github.com/repos/o/r/releases/assets/4'}]}});
    await assert.rejects(publishRelease({repo: 'o/r', tag: 'v1.2.3', name: 'v1.2.3', notes: 'x', assets: w.paths, token: TOKEN, fetchImpl: gh.fetchImpl}), /no SHA256SUMS asset/);
  } finally { w.cleanup(); }
});

test('publishRelease validates inputs before any request', async () => {
  const w = workdir({'one.tar.gz': 'ONE'});
  try {
    const gh = fakeGithub();
    const base = {repo: 'o/r', tag: 'v1.2.3', name: 'v1.2.3', notes: 'x', assets: w.paths, token: TOKEN, fetchImpl: gh.fetchImpl};
    await assert.rejects(publishRelease({...base, repo: 'o/r/../x'}), /Invalid repository/);
    await assert.rejects(publishRelease({...base, repo: 'o r'}), /Invalid repository/);
    await assert.rejects(publishRelease({...base, tag: 'v1.2'}), /Invalid tag/);
    await assert.rejects(publishRelease({...base, tag: '1.2.3'}), /Invalid tag/);
    await assert.rejects(publishRelease({...base, assets: ['/a/b/../SHA256SUMS\n']}), /./);
    await assert.rejects(publishRelease({...base, assets: [path.join(w.dir, 'bad name.tar.gz')]}), /Invalid asset name/);
    await assert.rejects(publishRelease({...base, token: ''}), /token/i);
    const saved = process.env.SOURCE_REVISION;
    try {
      process.env.SOURCE_REVISION = 'main';
      await assert.rejects(publishRelease(base), /SOURCE_REVISION/);
    } finally { process.env.SOURCE_REVISION = saved; }
    assert.equal(gh.calls.length, 0);
  } finally { w.cleanup(); }
});

test('errors never contain the token', async () => {
  const w = workdir({'one.tar.gz': 'ONE'});
  try {
    const gh = fakeGithub({createStatus: 422});
    await assert.rejects(publishRelease({repo: 'o/r', tag: 'v1.2.3', name: 'v1.2.3', notes: 'x', assets: w.paths, token: TOKEN, fetchImpl: gh.fetchImpl}), err => {
      assert.ok(!err.message.includes(TOKEN) && !err.message.includes('leaked body'));
      assert.match(err.message, /422/); assert.match(err.message, /\/repos\/o\/r\/releases/);
      return true;
    });
    const boom = async () => { throw Error(`connect failed with ${TOKEN}`); };
    await assert.rejects(publishRelease({repo: 'o/r', tag: 'v1.2.3', name: 'v1.2.3', notes: 'x', assets: w.paths, token: TOKEN, fetchImpl: boom}), err => !err.message.includes(TOKEN));
  } finally { w.cleanup(); }
});

test('manifest subcommand writes productionReady true and rejects a checksum mismatch', () => {
  const w = workdir({});
  try {
    const blob = 'deviceyard-community-1.2.3-linux-x64.tar.gz';
    fs.writeFileSync(path.join(w.dir, blob), 'ARCHIVE');
    const candidate = {schemaVersion: 1, edition: 'community', platform: 'linux-x64', entrypoint: 'dist/index.js', node: '>=22.13.0', version: '1.2.3', blob,
      revisions: {core: REV}, sha256: createHash('sha256').update('ARCHIVE').digest('hex')};
    const cand = path.join(w.dir, 'candidate.json'); const out = path.join(w.dir, 'out.json');
    fs.writeFileSync(cand, JSON.stringify(candidate));
    const run = () => spawnSync(process.execPath, [path.join(__dirname, 'publish.cjs'), 'manifest', cand, out], {encoding: 'utf8'});
    assert.equal(run().status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), {...candidate, productionReady: true});
    fs.rmSync(out);
    fs.writeFileSync(cand, JSON.stringify({...candidate, sha256: '0'.repeat(64)}));
    const bad = run();
    assert.notEqual(bad.status, 0);
    assert.ok(!fs.existsSync(out));
  } finally { w.cleanup(); }
});
