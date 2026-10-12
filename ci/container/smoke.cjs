#!/usr/bin/env node
// Integration checks use only disposable containers, volumes and credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {randomBytes} = require('node:crypto');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const exec = promisify(execFile);
const image = process.argv[2] || 'deviceyard-community:test';
const name = `deviceyard-smoke-${randomBytes(6).toString('hex')}`;
const volumes = [`${name}-data`, `${name}-adb`];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deviceyard-container-'));
const envFile = path.join(directory, 'runtime.env');
const password = randomBytes(24).toString('hex');
const env = {
  DEVICE_ID: 'smoke-device', TOKENS_JSON: '{}', ADMIN_USERNAME: 'smoke',
  ADMIN_EMAIL: 'smoke@example.invalid', ADMIN_PASSWORD: password,
  SESSION_SECRET: randomBytes(32).toString('hex'), TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
};
let stage = 'image availability';
async function docker(args, timeout = 120000) {
  try {
    const result = await exec('docker', args, {timeout, maxBuffer: 4 * 1024 * 1024});
    return (result.stdout + (args[0] === 'logs' ? result.stderr : '')).trim();
  }
  catch { throw Error(`Docker command failed during ${stage}; raw output withheld to protect runtime credentials`); }
}
function writeEnv(values) {
  fs.writeFileSync(envFile, Object.entries(values).map(([k,v]) => `${k}=${v}`).join('\n')+'\n', {mode: 0o600});
}
async function start() {
  await docker(['run', '-d', '--name', name, '--env-file', envFile,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '-p', '127.0.0.1::8080', '-v', `${volumes[0]}:/data`,
    '-v', `${volumes[1]}:/home/deviceyard/.android`, image]);
  const binding = JSON.parse(await docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', name]));
  const base = `http://127.0.0.1:${binding['8080/tcp'][0].HostPort}`;
  for (let i=0; i<120; i++) {
    if (await docker(['inspect','--format','{{.State.Running}}',name]) !== 'true') throw Error('Container exited before startup');
    try { if ((await fetch(base+'/login', {signal:AbortSignal.timeout(1000)})).status === 200) return base; } catch {}
    await new Promise(resolve => setTimeout(resolve,500));
  }
  throw Error('Container did not serve dashboard within timeout');
}
async function login(base) {
  const response = await fetch(base+'/api/session', {method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:'smoke',password}), signal:AbortSignal.timeout(10000)});
  assert.equal(response.status,200,'Persisted admin login must succeed');
  return response.headers.get('set-cookie').split(';')[0];
}
async function identity() {
  return docker(['exec', name, 'sha256sum', '/home/deviceyard/.android/adbkey.pub']);
}
async function stop() {
  await docker(['stop','--time','20',name]);
  assert.equal(await docker(['inspect','--format','{{.State.ExitCode}}',name]),'0','Application must stop gracefully');
  await docker(['rm',name]);
}
async function main() {
  try {
    await docker(['image','inspect','--format','{{.Id}}',image]);
    stage = 'runtime tools and contents';
    const uid = await docker(['run','--rm','--entrypoint','id',image,'-u']);
    assert.notEqual(uid,'0','Runtime must be non-root');
    await docker(['run','--rm','--entrypoint','test',image,'!','-e','/home/deviceyard/.maestro/analytics.json']);
    await docker(['run','--rm','--entrypoint','sh',image,'-ec',
      'node --version; java -version; adb version; maestro --version; test -s /opt/deviceyard/dist/src/public/index.html; test -s /opt/deviceyard/dist/src/mcp.mjs; test -s /opt/deviceyard/dist/cli.cjs; test -s /opt/deviceyard/dist/vendor/scrcpy/LICENSE; test -s /opt/deviceyard/notices/dependencies.json; test -s /opt/deviceyard/notices/os-packages.tsv; test ! -d /opt/deviceyard/tests; test ! -d /opt/deviceyard/.git; test ! -d /opt/deviceyard/node_modules/typescript; test ! -e /home/deviceyard/.android/adbkey']);
    stage = 'fresh-volume startup';
    writeEnv(env);
    const base = await start();
    const cookie = await login(base);
    for (let i=0; i<90; i++) {
      const health = await docker(['inspect','--format','{{.State.Health.Status}}',name]);
      if (health === 'healthy') break;
      if (health === 'unhealthy' || i === 89) throw Error('No-device container must become healthy');
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    const response = await fetch(base+'/api/edition',{headers:{cookie},signal:AbortSignal.timeout(10000)});
    const edition = await response.json();
    assert.equal(response.status,200);
    assert.equal(edition.edition,'community');
    assert.equal(edition.multiDevice,false);
    const paused = await fetch(base+'/api/admin/maintenance', {method:'PUT',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({requested:true}),signal:AbortSignal.timeout(10000)});
    assert.equal(paused.status,200,'Admin must be able to enable maintenance');
    assert.equal((await paused.json()).state,'ready');
    const publicIdentity = await identity();
    assert.match(publicIdentity,/^[a-f0-9]{64}\s/,'ADB public identity must exist');
    stage = 'graceful stop and volume persistence';
    await stop();
    // A new bootstrap password must not replace the persisted user's password.
    writeEnv({...env, ADMIN_PASSWORD:randomBytes(24).toString('hex')});
    const restarted = await start();
    const renewedCookie = await login(restarted);
    const maintenance = await fetch(restarted+'/api/maintenance',{headers:{cookie:renewedCookie},signal:AbortSignal.timeout(10000)});
    assert.equal(maintenance.status,200);
    assert.equal((await maintenance.json()).state,'ready','Maintenance must survive container recreation');
    const resumed = await fetch(restarted+'/api/admin/maintenance',{method:'PUT',headers:{cookie:renewedCookie,'Content-Type':'application/json'},body:JSON.stringify({requested:false}),signal:AbortSignal.timeout(10000)});
    assert.equal(resumed.status,200);
    assert.equal((await resumed.json()).state,'normal');
    assert.equal(await identity(),publicIdentity,'ADB authorization identity must persist');
    await stop();
    stage = 'invalid configuration';
    for (const override of [{ADMIN_PASSWORD:''},{TOKENS_JSON:`{"invalid":"${password}`}]) {
      writeEnv({...env,...override});
      await docker(['run','-d','--name',name,'--env-file',envFile,image]);
      const code = await docker(['wait',name],30000);
      assert.notEqual(code,'0','Invalid configuration must fail');
      const logs = await docker(['logs',name]);
      assert.ok(!logs.includes(password),'Credential leaked in invalid-config output');
      await docker(['rm',name]);
    }
    console.log('Container smoke passed: tools, non-root startup, Community policy, durable data/ADB identity, graceful stop, sanitized config failures');
  } finally {
    await docker(['rm','-f',name]).catch(()=>{});
    for (const volume of volumes) await docker(['volume','rm',volume]).catch(()=>{});
    fs.rmSync(directory,{recursive:true,force:true});
  }
}
main().catch(error => { console.error(`Container smoke failed (${stage}): ${error.message}`); process.exitCode=1; });
