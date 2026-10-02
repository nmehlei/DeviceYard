const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);}
for(const dir of ['src','shared','cli/src','dashboard/src']) {
  for(const file of walk(path.join(root,dir)).filter(f=>/\.(ts|tsx|js|mjs|cjs)$/.test(f))) {
    const source=fs.readFileSync(file,'utf8');
    if(/\bclass\s+(PoolScheduler|LicenseStore|ProPolicy)\b|from\s+['"][^'"]*\/pro\//.test(source)) throw Error(`Private implementation found in ${path.relative(root,file)}`);
  }
}
if(fs.existsSync(path.join(root,'pro'))) throw Error('Community must not contain a pro directory');
for(const file of ['LICENSE','vendor/scrcpy/LICENSE']) if(!fs.statSync(path.join(root,file)).size) throw Error(`Missing license: ${file}`);
console.log('Community source boundary passed');
