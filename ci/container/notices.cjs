const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = '/opt/deviceyard/notices';
// Source-built images ship LICENSE at the top level; release images ship it under notices/.
const licensePath = fs.existsSync('/opt/deviceyard/LICENSE') ? '/opt/deviceyard/LICENSE' : '/opt/deviceyard/notices/LICENSE';
fs.mkdirSync(root, {recursive:true});
fs.writeFileSync(path.join(root,'os-packages.tsv'), execFileSync('dpkg-query', ['-W','-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n']));
fs.copyFileSync('/usr/local/LICENSE',path.join(root,'node-LICENSE'));
// Debian keeps per-package copyright files in /usr/share/doc; retain those in
// place and make their location explicit rather than claiming SPDX metadata is
// a complete distribution notice audit.
const scrcpyLicense = ['/opt/deviceyard/dist/vendor/scrcpy/LICENSE','/opt/deviceyard/dist/core/vendor/scrcpy/LICENSE'].find(file=>fs.existsSync(file)) || '/opt/deviceyard/dist/vendor/scrcpy/LICENSE';
const jars = fs.readdirSync('/opt/maestro/lib').filter(name=>name.endsWith('.jar')).sort();
fs.writeFileSync(path.join(root,'maestro-jars.json'),JSON.stringify(jars,null,2)+'\n');
fs.writeFileSync(path.join(root,'README.txt'),
  'First-party license: '+licensePath+'\n'+
  'JavaScript dependency notices (build-time superset): dependencies.json\n'+
  'Node and bundled components: node-LICENSE\n'+
  'Debian/Java/ADB/tini/tar licenses: /usr/share/doc/*/copyright\n'+
  'Maestro libraries: /opt/maestro/lib; inventory: maestro-jars.json\n'+
  'scrcpy: '+scrcpyLicense+'\n'+
  'Publication review remains required for bundled libraries and source correspondence.\n');
console.log('Recorded runtime package versions and notice locations');
