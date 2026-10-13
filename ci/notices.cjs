// Generate a reviewable inventory from installed, lockfile-pinned packages.
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const serverRoot=process.argv[2] ? path.resolve(process.argv[2]) : root;
const dashboardRoot=process.argv[3] ? path.resolve(process.argv[3]) : path.join(root,'dashboard');
const destination=process.argv[4] ? path.resolve(process.argv[4]) : path.join(root,'docs/licenses/dependencies.json');
const inventory=[];
for(const area of ['.','dashboard']){
  const base=area==='.' ? serverRoot : dashboardRoot;
  const lock=JSON.parse(fs.readFileSync(path.join(base,'package-lock.json')));
  for(const [location,entry] of Object.entries(lock.packages)){
    if(!location.includes('node_modules/')||entry.link)continue;
    const directory=path.join(base,location);
    let pkg;try{pkg=JSON.parse(fs.readFileSync(path.join(directory,'package.json')));}catch{continue;}
    const notices=fs.readdirSync(directory).filter(name=>/^(licen[cs]e|copying|notice)([.-]|$)/i.test(name)&&fs.statSync(path.join(directory,name)).isFile());
    // Some packages (for example cookie-signature) put the actual license
    // grant in their README instead of shipping a standalone license file.
    if(!notices.length){
      for(const name of fs.readdirSync(directory).filter(name=>/^readme([.-]|$)/i.test(name))){
        const file=path.join(directory,name);
        if(fs.statSync(file).isFile() && /permission is hereby granted|redistribution and use in source and binary forms/i.test(fs.readFileSync(file,'utf8')))notices.push(name);
      }
    }
    inventory.push({area,name:pkg.name,version:pkg.version,license:pkg.license||entry.license||'SEE LICENSE FILE',dev:!!entry.dev,
      notices:notices.map(name=>({file:name,text:fs.readFileSync(path.join(directory,name),'utf8')}))});
  }
}
fs.mkdirSync(path.dirname(destination),{recursive:true});
fs.writeFileSync(destination,JSON.stringify(inventory,null,2)+'\n');
console.log(`Recorded notices for ${inventory.length} installed dependencies; platform-specific packages absent from this host need release-host verification.`);
