#!/usr/bin/env node
// Deliberately absent from CI triggers. Requires separately authorized promotion.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {execFileSync} = require('node:child_process');

function approvedManifest(manifest, archive, reviewedKeyIds = []) {
  if (manifest.schemaVersion !== 1 || !['community', 'pro'].includes(manifest.edition) || manifest.platform !== 'linux-x64' ||
      manifest.entrypoint !== 'dist/index.js' || manifest.node !== '>=22.13.0') throw Error('Unsupported native release contract');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version || '') ||
      manifest.blob !== `deviceyard-${manifest.edition}-${manifest.version}-linux-x64.tar.gz`) throw Error('Invalid native release name');
  if (!manifest.revisions?.core || (manifest.edition === 'pro' && !manifest.revisions.pro) ||
      !Object.values(manifest.revisions).every(value => /^[a-f0-9]{40}$/.test(value))) throw Error('Missing source revisions');
  if (manifest.edition === 'pro' && (!Array.isArray(manifest.trustedKeyIds) || !manifest.trustedKeyIds.length ||
      manifest.trustedKeyIds.some(id => !reviewedKeyIds.includes(id)))) throw Error('Pro promotion requires explicitly reviewed verification-key IDs');
  if (createHash('sha256').update(fs.readFileSync(archive)).digest('hex') !== manifest.sha256) throw Error('Candidate checksum mismatch');
  return {...manifest, productionReady:true};
}
module.exports = {approvedManifest};
if (require.main === module) {
  let temp;
  try {
    const [file, account, container, approval, ...reviewedKeyIds] = process.argv.slice(2);
    if (approval !== '--reviewed-and-approved' || !/^[a-z0-9]{3,24}$/.test(account || '') || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(container || '')) throw Error();
    const candidate = JSON.parse(fs.readFileSync(file));
    // Validate the name before joining a path supplied by an artifact manifest.
    if (typeof candidate.blob !== 'string' || path.basename(candidate.blob) !== candidate.blob) throw Error();
    const archive = path.join(path.dirname(path.resolve(file)), candidate.blob);
    const manifest = approvedManifest(candidate, archive, reviewedKeyIds);
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-promotion-'));
    const marker = path.join(temp, 'latest.json'); fs.writeFileSync(marker, JSON.stringify(manifest, null, 2) + '\n');
    const prefix = `native/${manifest.edition}/linux-x64/`;
    const upload = (name, source, overwrite) => execFileSync('az', ['storage', 'blob', 'upload', '--account-name', account,
      '--container-name', container, '--name', prefix + name, '--file', source, '--auth-mode', 'login',
      '--overwrite', String(overwrite), '--only-show-errors', '--output', 'none'], {stdio:'pipe'});
    // Immutable archive first. A failed upload cannot advance the channel.
    upload(manifest.blob, archive, false);
    upload('latest.json', marker, true);
    console.log('Promoted approved native candidate to its isolated edition channel');
  } catch { console.error('Native promotion refused or failed; raw service output withheld'); process.exitCode = 1; }
  finally { if (temp) fs.rmSync(temp, {recursive:true, force:true}); }
}
