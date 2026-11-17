#!/usr/bin/env node
// The public Pro download index (index.json): every published version, newest first.
// Published versions are immutable: re-adding one with the same sha256 changes nothing,
// with a different sha256 it fails and the index stays as it was. Updaters trust the
// sha256 in this file, so every URL must point under the download base and its version.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BASE_URL = 'https://deviceyarddownloads.blob.core.windows.net/pro';
// Parts are capped at 9 digits so they compare exactly as numbers.
const SEMVER = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_NOTES = 100;
const MAX_NOTE_LENGTH = 1000;

const isString = (value) => typeof value === 'string';
const isVersion = (value) => isString(value) && SEMVER.test(value);

function parts(version) {
  return SEMVER.exec(version).slice(1).map(Number);
}

function compareDescending(a, b) {
  const [x, y] = [parts(a.version), parts(b.version)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return y[i] - x[i];
  return 0;
}

// URL of a plain file name directly inside <baseUrl>/<version>/.
function isReleaseUrl(value, baseUrl, version) {
  if (!isString(value) || !value.startsWith(`${baseUrl}/${version}/`)) return false;
  const file = value.slice(baseUrl.length + version.length + 2);
  return FILE.test(file) && !file.includes('..');
}

// Returns a copy holding only the known fields; throws when anything is off.
function normalizeEntry(entry, baseUrl) {
  const fail = () => { throw Error(`Malformed release entry${entry && isString(entry.version) ? ` ${entry.version}` : ''}`); };
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail();
  const {version, date, notes, coreVersion, image, archive, manifestUrl, licenseUrl} = entry;
  if (!isVersion(version) || !isVersion(coreVersion) || !isString(date) || !DATE.test(date)
    || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || !isString(image) || image.length > 200
    || !Array.isArray(notes) || notes.length > MAX_NOTES
    || notes.some((line) => !isString(line) || line.length > MAX_NOTE_LENGTH)
    || !archive || typeof archive !== 'object' || !isString(archive.file) || !FILE.test(archive.file) || archive.file.includes('..')
    || archive.url !== `${baseUrl}/${version}/${archive.file}`
    || !Number.isSafeInteger(archive.size) || archive.size <= 0 || !isString(archive.sha256) || !SHA256.test(archive.sha256)
    || !isReleaseUrl(manifestUrl, baseUrl, version) || !isReleaseUrl(licenseUrl, baseUrl, version)) fail();
  return {version, date, notes:[...notes], coreVersion, image,
    archive:{file:archive.file, url:archive.url, size:archive.size, sha256:archive.sha256}, manifestUrl, licenseUrl};
}

function normalizeIndex(index, baseUrl) {
  if (!index || typeof index !== 'object' || Array.isArray(index) || index.schemaVersion !== 1 || !Array.isArray(index.releases)) {
    throw Error('Malformed download index');
  }
  let releases;
  try { releases = index.releases.map((release) => normalizeEntry(release, baseUrl)); } catch (error) {
    throw Error(`Malformed download index: ${error.message}`);
  }
  if (new Set(releases.map((release) => release.version)).size !== releases.length) {
    throw Error('Malformed download index: a version is listed twice');
  }
  return releases;
}

function addRelease(index, entry, {baseUrl = DEFAULT_BASE_URL} = {}) {
  const added = normalizeEntry(entry, baseUrl);
  const releases = index === null ? [] : normalizeIndex(index, baseUrl);
  const existing = releases.find((release) => release.version === added.version);
  if (existing && existing.archive.sha256 !== added.archive.sha256) {
    throw Error(`Version ${added.version} already published with different contents`);
  }
  return {schemaVersion:1, releases:(existing ? releases : [...releases, added]).sort(compareDescending)};
}

module.exports = {addRelease, DEFAULT_BASE_URL};
if (require.main === module) {
  try {
    const [command, indexFile, entryFile, outFile] = process.argv.slice(2);
    if (command !== 'add' || !indexFile || !entryFile || !outFile) {
      throw Error('Usage: downloads-index.cjs add <index.json|-> <entry.json> <out.json>');
    }
    const index = indexFile === '-' ? null : JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    const result = addRelease(index, JSON.parse(fs.readFileSync(entryFile, 'utf8')),
      {baseUrl:process.env.DEVICEYARD_DOWNLOADS_BASE_URL || DEFAULT_BASE_URL});
    // Write next to the target and rename, so a failure never leaves a truncated index.
    const temp = path.join(path.dirname(path.resolve(outFile)), `.${path.basename(outFile)}.${process.pid}.tmp`);
    fs.writeFileSync(temp, `${JSON.stringify(result, null, 2)}\n`);
    fs.renameSync(temp, outFile);
    console.log(`Download index lists ${result.releases.length} release(s); newest ${result.releases[0].version}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
