#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const run = (args, cwd=root) => execFileSync('npm', args, {cwd,stdio:'inherit'});
require('./check-boundary.cjs');
// Only generated output is removed; a clean build cannot reuse stale Pro assets.
fs.rmSync(path.join(root,'dist'), {recursive:true,force:true});
run(['run','build:server']);
run(['run','build:mcp']);
run(['run','build:cli']);
run(['run','build','--',...process.argv.slice(2)], path.join(root,'dashboard'));
for (const [from,to] of [['dashboard/out','dist/src/public'],['vendor/scrcpy','dist/vendor/scrcpy'],['cli/install.sh','dist/src/install.sh']]) {
  fs.mkdirSync(path.dirname(path.join(root,to)), {recursive:true});
  fs.cpSync(path.join(root,from),path.join(root,to),{recursive:true});
}
fs.writeFileSync(path.join(root,'dist/index.js'),'require("./entry.js");\n');
for(const file of ['dist/entry.js','dist/src/public/index.html','dist/src/mcp.mjs','dist/src/install.sh','dist/vendor/scrcpy/scrcpy-server-v3.3.2','dist/vendor/scrcpy/LICENSE','dist/cli.cjs']) {
  if(!fs.statSync(path.join(root,file)).size) throw Error(`Missing runtime asset: ${file}`);
}
