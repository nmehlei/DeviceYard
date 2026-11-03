#!/usr/bin/env node
// Publishes a GitHub release idempotently and writes approved native manifests.
// Never prints the token or raw service responses: errors carry only method, endpoint path and HTTP status.
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {pipeline} = require('node:stream/promises');
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

const parts = version => version.split('.').map(Number);
const compare = (a, b) => { const x = parts(a), y = parts(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };

// Tags to push for `version`: always its own tag; a floating tag (<major>.<minor>, <major>, latest)
// only when no existing strict vX.Y.Z release within that prefix is newer, so re-running an older
// build never moves a floating tag backwards. `existing` may contain tag names (v1.2.3) or versions.
function floatingTags(image, version, existing = []) {
  const [own, minorTag, majorTag, latestTag] = imageTags(image, version);
  const [major, minor] = parts(version);
  const versions = existing.map(entry => String(entry).replace(/^v/, '')).filter(entry => VERSION.test(entry));
  const newest = within => versions.filter(within).every(other => compare(version, other) >= 0);
  const tags = [own];
  if (newest(other => parts(other)[0] === major && parts(other)[1] === minor)) tags.push(minorTag);
  if (newest(other => parts(other)[0] === major)) tags.push(majorTag);
  if (newest(() => true)) tags.push(latestTag);
  return tags;
}

// Stream the file so large archives are never held in memory for hashing.
async function digest(file) {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}
const GITHUB_HOSTS = new Set(['api.github.com', 'uploads.github.com']);
const assetName = file => {
  const name = path.basename(String(file));
  if (name === '..' || !ASSET_NAME.test(name)) throw Error('Invalid asset name');
  return name;
};

async function sha256sums(files) {
  const entries = [];
  for (const file of files) entries.push({name: assetName(file), hash: await digest(file)});
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({name, hash}) => `${hash}  ${name}\n`).join('');
}

function validateTarget(repo, tag, token) {
  if (typeof repo !== 'string' || !REPO.test(repo) || repo.split('/')[1].startsWith('.')) throw Error('Invalid repository');
  if (typeof tag !== 'string' || !tag.startsWith('v') || !VERSION.test(tag.slice(1))) throw Error('Invalid tag');
  if (typeof token !== 'string' || !token) throw Error('Missing publish token');
}

// The token is only ever sent to GitHub's API and upload hosts; errors carry method, path and status only.
function githubClient(token, fetchImpl) {
  const headers = extra => ({Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...extra});
  const request = async (method, url, init = {}) => {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !GITHUB_HOSTS.has(target.hostname)) throw Error('Refusing to send the token to a non-GitHub host');
    const where = `${method} ${target.pathname}`;
    let response;
    try { response = await fetchImpl(url, {method, ...init}); }
    catch { throw Error(`${where} failed: request error`); }
    return {response, where};
  };
  const fail = (where, response) => Error(`${where} failed with HTTP ${response.status}`);
  return {headers, request, fail};
}

// 'published' when a non-draft release exists for the tag (GitHub hides drafts from the tag lookup).
async function releaseState({repo, tag, token, fetchImpl = fetch}) {
  validateTarget(repo, tag, token);
  const {headers, request, fail} = githubClient(token, fetchImpl);
  const lookup = await request('GET', `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {headers: headers()});
  if (lookup.response.status === 200) return (await lookup.response.json()).draft === true ? 'draft-or-missing' : 'published';
  if (lookup.response.status === 404) return 'draft-or-missing';
  throw fail(lookup.where, lookup.response);
}

async function publishRelease({repo, tag, name, notes, assets, token, commitish = process.env.SOURCE_REVISION, fetchImpl = fetch}) {
  validateTarget(repo, tag, token);
  if (typeof commitish !== 'string' || !/^[a-f0-9]{40}$/.test(commitish)) throw Error('SOURCE_REVISION must be a 40-character commit SHA');
  if (!Array.isArray(assets) || !assets.length) throw Error('No assets to publish');
  // The checksum file is derived here; a pre-written SHA256SUMS passed by the CLI is replaced by the computed one.
  const files = assets.filter(file => assetName(file) !== SUMS);
  const names = files.map(assetName);
  if (new Set(names).size !== names.length) throw Error('Duplicate asset names');
  const sums = await sha256sums(files);
  // Each file is read only at its own upload; SHA256SUMS goes last so it marks a complete upload set.
  const uploads = [...files.map((file, i) => ({name: names[i], read: () => fs.promises.readFile(file)})), {name: SUMS, read: async () => Buffer.from(sums)}];

  const {headers, request, fail} = githubClient(token, fetchImpl);

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

  // GitHub hides drafts from the tag lookup; a draft with this tag is a half-finished earlier run.
  const listing = await request('GET', `${api}/releases?per_page=100`, {headers: headers()});
  if (!listing.response.ok) throw fail(listing.where, listing.response);
  for (const stale of (await listing.response.json()).filter(release => release.draft === true && release.tag_name === tag)) {
    const removal = await request('DELETE', `${api}/releases/${encodeURIComponent(stale.id)}`, {headers: headers()});
    if (!removal.response.ok) throw fail(removal.where, removal.response);
  }

  const create = await request('POST', `${api}/releases`, {headers: headers({'Content-Type': 'application/json'}),
    body: JSON.stringify({tag_name: tag, name, body: notes, target_commitish: commitish, draft: true, prerelease: false})});
  if (create.response.status !== 201) throw fail(create.where, create.response);
  const created = await create.response.json();
  const uploadUrl = String(created.upload_url || '').replace(/\{[^}]*\}$/, '');
  if (!/^https:\/\//.test(uploadUrl)) throw Error(`${create.where} returned no upload URL`);
  for (const {name: assetFile, read} of uploads) {
    const body = await read();
    const upload = await request('POST', `${uploadUrl}?name=${encodeURIComponent(assetFile)}`,
      {headers: headers({'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length)}), body});
    if (upload.response.status !== 201) throw fail(upload.where, upload.response);
  }
  const publish = await request('PATCH', `${api}/releases/${encodeURIComponent(created.id)}`, {headers: headers({'Content-Type': 'application/json'}), body: JSON.stringify({draft: false})});
  if (publish.response.status !== 200) throw fail(publish.where, publish.response);
  return 'created';
}

module.exports = {imageTags, floatingTags, releaseState, publishRelease, sha256sums};

if (require.main === module) {
  (async () => {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'manifest') {
      const [candidateFile, outFile, keyIds = ''] = args;
      if (!candidateFile || !outFile) throw Error('usage: manifest <candidate.json> <out.json> [keyIds]');
      const candidate = JSON.parse(fs.readFileSync(candidateFile, 'utf8'));
      // Validate the name before joining a path supplied by an artifact manifest.
      if (typeof candidate.blob !== 'string' || path.basename(candidate.blob) !== candidate.blob || ['.', '..'].includes(candidate.blob)) throw Error('Invalid archive name');
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
      fs.writeFileSync(sumsFile, await sha256sums(files));
      const result = await publishRelease({repo, tag: `v${version}`, name: `v${version}`, notes: fs.readFileSync(notesFile, 'utf8'),
        assets: [...files, sumsFile], token: process.env.GITHUB_PUBLISH_TOKEN});
      console.log(`Release v${version} ${result}`);
    } else if (command === 'release-state') {
      const [repo, version] = args;
      if (!VERSION.test(version || '')) throw Error('usage: release-state <repo> <version>');
      console.log(await releaseState({repo, tag: `v${version}`, token: process.env.GITHUB_PUBLISH_TOKEN}));
    } else if (command === 'tags') {
      const [image, version, ...existing] = args;
      if (!image || !VERSION.test(version || '')) throw Error('usage: tags <image> <version> [existing tag]...');
      console.log(floatingTags(image, version, existing).join('\n'));
    } else throw Error('usage: publish.cjs manifest|github|release-state|tags ...');
  })().catch(error => { console.error(`Publish failed: ${error.message}`); process.exitCode = 1; });
}
