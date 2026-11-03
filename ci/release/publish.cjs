#!/usr/bin/env node
// Publishes a GitHub release idempotently and writes approved native manifests.
// Never prints the token or raw service responses: errors carry only method, endpoint path and HTTP status.
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {approvedManifest} = require('../native/promote.cjs');

const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SUMS = 'SHA256SUMS';

function imageTags(image, version) {
  if (typeof version !== 'string' || !VERSION.test(version)) throw Error('Invalid version');
  const [major, minor] = version.split('.');
  return [version, `${major}.${minor}`, major, 'latest'].map(tag => `${image}:${tag}`);
}

const digest = buffer => createHash('sha256').update(buffer).digest('hex');
const assetName = file => {
  const name = path.basename(String(file));
  if (name === '..' || !ASSET_NAME.test(name)) throw Error('Invalid asset name');
  return name;
};

function sha256sums(files) {
  return files.map(file => ({name: assetName(file), hash: digest(fs.readFileSync(file))}))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({name, hash}) => `${hash}  ${name}\n`).join('');
}

async function publishRelease({repo, tag, name, notes, assets, token, commitish = process.env.SOURCE_REVISION, fetchImpl = fetch}) {
  if (typeof repo !== 'string' || !REPO.test(repo) || repo.split('/')[1].startsWith('.')) throw Error('Invalid repository');
  if (typeof tag !== 'string' || !tag.startsWith('v') || !VERSION.test(tag.slice(1))) throw Error('Invalid tag');
  if (typeof token !== 'string' || !token) throw Error('Missing publish token');
  if (typeof commitish !== 'string' || !/^[a-f0-9]{40}$/.test(commitish)) throw Error('SOURCE_REVISION must be a 40-character commit SHA');
  if (!Array.isArray(assets) || !assets.length) throw Error('No assets to publish');
  // The checksum file is derived here; a pre-written SHA256SUMS passed by the CLI is replaced by the computed one.
  const files = assets.filter(file => assetName(file) !== SUMS);
  const names = files.map(assetName);
  if (new Set(names).size !== names.length) throw Error('Duplicate asset names');
  const sums = sha256sums(files);
  const uploads = [...files.map((file, i) => ({name: names[i], body: fs.readFileSync(file)})), {name: SUMS, body: Buffer.from(sums)}];

  const headers = extra => ({Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...extra});
  const request = async (method, url, init = {}) => {
    const where = `${method} ${new URL(url).pathname}`;
    let response;
    try { response = await fetchImpl(url, {method, ...init}); }
    catch { throw Error(`${where} failed: request error`); }
    return {response, where};
  };
  const fail = (where, response) => Error(`${where} failed with HTTP ${response.status}`);

  const api = `https://api.github.com/repos/${repo}`;
  const lookup = await request('GET', `${api}/releases/tags/${encodeURIComponent(tag)}`, {headers: headers()});
  if (lookup.response.status === 200) {
    const existing = await lookup.response.json();
    const remote = (existing.assets || []).find(asset => asset.name === SUMS);
    if (!remote) throw Error(`Release ${tag} exists but has no ${SUMS} asset (an earlier run may have been interrupted); resolve it manually`);
    const download = await request('GET', remote.url, {headers: headers({Accept: 'application/octet-stream'})});
    if (!download.response.ok) throw fail(download.where, download.response);
    if ((await download.response.text()) !== sums) throw Error(`Release ${tag} already exists with different contents`);
    return 'unchanged';
  }
  if (lookup.response.status !== 404) throw fail(lookup.where, lookup.response);

  const create = await request('POST', `${api}/releases`, {headers: headers({'Content-Type': 'application/json'}),
    body: JSON.stringify({tag_name: tag, name, body: notes, target_commitish: commitish, draft: false, prerelease: false})});
  if (create.response.status !== 201) throw fail(create.where, create.response);
  const uploadUrl = String((await create.response.json()).upload_url || '').replace(/\{[^}]*\}$/, '');
  if (!/^https:\/\//.test(uploadUrl)) throw Error(`${create.where} returned no upload URL`);
  for (const {name: assetFile, body} of uploads) {
    const upload = await request('POST', `${uploadUrl}?name=${encodeURIComponent(assetFile)}`,
      {headers: headers({'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length)}), body});
    if (upload.response.status !== 201) throw fail(upload.where, upload.response);
  }
  return 'created';
}

module.exports = {imageTags, publishRelease, sha256sums};

if (require.main === module) {
  (async () => {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'manifest') {
      const [candidateFile, outFile, keyIds = ''] = args;
      if (!candidateFile || !outFile) throw Error('usage: manifest <candidate.json> <out.json> [keyIds]');
      const candidate = JSON.parse(fs.readFileSync(candidateFile, 'utf8'));
      // Validate the name before joining a path supplied by an artifact manifest.
      if (typeof candidate.blob !== 'string' || path.basename(candidate.blob) !== candidate.blob) throw Error('Invalid archive name');
      const archive = path.join(path.dirname(path.resolve(candidateFile)), candidate.blob);
      const manifest = approvedManifest(candidate, archive, keyIds.split(',').filter(Boolean));
      fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2) + '\n');
      console.log('Wrote approved manifest');
    } else if (command === 'github') {
      const [repo, version, notesFile, ...assets] = args;
      if (!notesFile || !assets.length) throw Error('usage: github <repo> <version> <notes.md> <asset>...');
      if (!VERSION.test(version || '')) throw Error('Invalid version');
      const sumsFile = path.join(path.dirname(path.resolve(assets[0])), SUMS);
      const files = assets.filter(file => assetName(file) !== SUMS);
      fs.writeFileSync(sumsFile, sha256sums(files));
      const result = await publishRelease({repo, tag: `v${version}`, name: `v${version}`, notes: fs.readFileSync(notesFile, 'utf8'),
        assets: [...files, sumsFile], token: process.env.GITHUB_PUBLISH_TOKEN});
      console.log(`Release v${version} ${result}`);
    } else throw Error('usage: publish.cjs manifest|github ...');
  })().catch(error => { console.error(`Publish failed: ${error.message}`); process.exitCode = 1; });
}
