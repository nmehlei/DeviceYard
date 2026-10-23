const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const toolRoot = path.resolve(__dirname, '../..');

function gitVersion(root = toolRoot) {
  const run = (args, cwd = root) => execFileSync('git', args, {cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  if (run(['rev-parse','--is-shallow-repository']) !== 'false') throw Error('GitVersion requires full Community history');
  const revision = run(['rev-parse','HEAD']);
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'deviceyard-version-')));
  try {
    // Calculate only the pinned commit's history. In Pro, origin/main can be
    // newer and the build-server environment describes the Pro repository.
    const repo = path.join(work,'repo');
    run(['clone','--no-checkout','--no-hardlinks',root,repo]);
    run(['checkout','-B','main',revision],repo);
    run(['remote','remove','origin'],repo);
    // Tags added after this revision must not affect its version calculation.
    const tags = run(['tag','--no-merged',revision],repo);
    if (tags) for (const tag of tags.split('\n')) run(['tag','-d',tag],repo);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      ['PATH','HOME','DOTNET_ROOT','DOTNET_ROOT_X64','TMPDIR','TEMP','TMP','NUGET_PACKAGES'].includes(key)));
    env.DOTNET_ROLL_FORWARD = 'Major';
    const output = execFileSync('dotnet',['tool','run','dotnet-gitversion','--',repo,'/output','json','/nofetch'],
      {cwd:toolRoot,env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
    const result = JSON.parse(output);
    if (result.Sha !== revision || !/^\d+\.\d+\.\d+$/.test(result.SemVer)) throw Error('Invalid pinned GitVersion result');
    return result.SemVer;
  } finally { fs.rmSync(work,{recursive:true,force:true}); }
}
module.exports = {gitVersion};
