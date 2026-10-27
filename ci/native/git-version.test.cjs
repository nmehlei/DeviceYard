const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {gitVersion} = require('./git-version.cjs');

test('GitVersion 5 Mainline increments and core metadata stays bound to the exact Community pin', () => {
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'deviceyard-version-test-'));
  const repo=path.join(work,'community'); fs.mkdirSync(repo);
  const git=(args,cwd=repo)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  try {
    git(['init','-b','main']); git(['config','user.name','Version Test']); git(['config','user.email','test@example.invalid']);
    fs.copyFileSync(path.join(__dirname,'../../GitVersion.yml'),path.join(repo,'GitVersion.yml'));
    git(['add','GitVersion.yml']); git(['commit','-m','Initialize edition version']);
    git(['tag','v1.0.0']);
    assert.equal(gitVersion(repo),'1.0.0');
    fs.writeFileSync(path.join(repo,'change.txt'),'fix'); git(['add','.']); git(['commit','-m','Fix next release']);
    assert.equal(gitVersion(repo),'1.0.1');
    const pin=git(['rev-parse','HEAD']);
    fs.writeFileSync(path.join(repo,'change.txt'),'minor'); git(['add','.']); git(['commit','-m','Add capability +semver: minor']);
    assert.equal(gitVersion(repo),'1.1.0');
    git(['tag','v1.1.0']);
    const proCore=path.join(work,'pro-core');
    git(['clone',repo,proCore]); git(['checkout','--detach',pin],proCore);
    assert.equal(gitVersion(proCore),'1.0.1','newer main and tags must not change the pinned core version');
    git(['switch','-c','feature']); fs.writeFileSync(path.join(repo,'change.txt'),'feature'); git(['add','.']); git(['commit','-m','Feature fix']);
    git(['switch','main']); git(['merge','--no-ff','feature','-m','Merge feature']);
    assert.equal(gitVersion(repo),'1.1.1');
    const shallow=path.join(work,'shallow'); git(['clone','--depth','1','file://'+repo,shallow]);
    assert.throws(()=>gitVersion(shallow),/full Community history/);
  } finally { fs.rmSync(work,{recursive:true,force:true}); }
});
