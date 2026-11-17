#!/usr/bin/env node
// The public Pro download index (index.json): every published version, newest first.
// Published versions are immutable: re-adding one with the same sha256 changes nothing,
// with a different sha256 it fails and the index stays as it was.
const fs = require('node:fs');

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const SHA256 = /^[0-9a-f]{64}$/;

const isUrl = (value) => typeof value === 'string' && value.startsWith('https://');

function parts(version) {
  const match = SEMVER.exec(version);
  if (!match) throw Error(`Invalid version ${version}`);
  return match.slice(1).map(Number);
}

function compareDescending(a, b) {
  const [x, y] = [parts(a.version), parts(b.version)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return y[i] - x[i];
  return 0;
}

function assertEntry(entry) {
  const ok = entry && typeof entry === 'object' && SEMVER.test(entry.version)
    && typeof entry.date === 'string' && Array.isArray(entry.notes) && entry.notes.every((line) => typeof line === 'string')
    && SEMVER.test(entry.coreVersion) && typeof entry.image === 'string'
    && entry.archive && typeof entry.archive.file === 'string' && isUrl(entry.archive.url)
    && Number.isSafeInteger(entry.archive.size) && entry.archive.size > 0 && SHA256.test(entry.archive.sha256)
    && isUrl(entry.manifestUrl) && isUrl(entry.licenseUrl);
  if (!ok) throw Error(`Malformed release entry${entry && entry.version ? ` ${entry.version}` : ''}`);
}

function assertIndex(index) {
  if (!index || typeof index !== 'object' || Array.isArray(index) || index.schemaVersion !== 1 || !Array.isArray(index.releases)) {
    throw Error('Malformed download index');
  }
  try { index.releases.forEach(assertEntry); } catch (error) { throw Error(`Malformed download index: ${error.message}`); }
}

function addRelease(index, entry) {
  assertEntry(entry);
  const current = index === null ? {schemaVersion:1, releases:[]} : index;
  assertIndex(current);
  const existing = current.releases.find((release) => release.version === entry.version);
  if (existing) {
    if (existing.archive.sha256 !== entry.archive.sha256) throw Error(`Version ${entry.version} already published with different contents`);
    return current;
  }
  return {schemaVersion:1, releases:[...current.releases, entry].sort(compareDescending)};
}

module.exports = {addRelease};
if (require.main === module) {
  try {
    const [command, indexFile, entryFile, outFile] = process.argv.slice(2);
    if (command !== 'add' || !indexFile || !entryFile || !outFile) {
      throw Error('Usage: downloads-index.cjs add <index.json|-> <entry.json> <out.json>');
    }
    const index = indexFile === '-' ? null : JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    const result = addRelease(index, JSON.parse(fs.readFileSync(entryFile, 'utf8')));
    fs.writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Download index lists ${result.releases.length} release(s); newest ${result.releases[0].version}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
