#!/usr/bin/env node
// Exercise only the extracted runtime with fresh throwaway credentials and no devices.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {randomBytes, createHash} = require('node:crypto');
const {spawn, execFileSync} = require('node:child_process');
const {once} = require('node:events');

async function smoke(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  if (!/^deviceyard-(community|pro)-[0-9A-Za-z.-]+-linux-x64\.tar\.gz$/.test(manifest.blob)) throw Error('Invalid archive name');
  const archive = path.join(path.dirname(manifestPath), manifest.blob);
  if (createHash('sha256').update(fs.readFileSync(archive)).digest('hex') !== manifest.sha256) throw Error('Archive checksum mismatch');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deviceyard-native-smoke-'));
  const runtime = path.join(temp, 'runtime'); fs.mkdirSync(runtime);
  const data = path.join(temp, 'data'); fs.mkdirSync(data);
  let child;
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await exit; } finally { clearTimeout(timer); }
  }
  try {
    execFileSync('tar', ['-xzf', archive, '-C', runtime]);
    if (fs.existsSync(path.join(runtime, 'src')) || fs.existsSync(path.join(runtime, 'node_modules/typescript'))) throw Error('Native package contains development inputs');
    const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port; await new Promise(resolve => server.close(resolve));
    const password = randomBytes(24).toString('hex');
    const token = randomBytes(24).toString('hex');
    const env = {PATH:process.env.PATH, HOME:temp, NODE_ENV:'test', PORT:String(port), DATA_DIR:data,
      DEVICE_ID:'native-smoke-device', TOKENS_JSON:JSON.stringify({smoke:token}), DEVICEYARD_CUSTOMER_ID:'native-smoke-customer',
      ADMIN_USERNAME:'smoke', ADMIN_EMAIL:'smoke@example.invalid', ADMIN_PASSWORD:password,
      SESSION_SECRET:randomBytes(32).toString('hex'), TOKEN_ENCRYPTION_KEY:randomBytes(32).toString('hex')};
    const base = `http://127.0.0.1:${port}`;
    let cookie;
    async function call(route, method = 'GET', body) {
      const response = await fetch(base + route, {method, signal:AbortSignal.timeout(5000),
        headers:{'Content-Type':'application/json', ...(cookie ? {cookie} : {})}, ...(body === undefined ? {} : {body:JSON.stringify(body)})});
      if (!response.ok) throw Error(`Native smoke failed: ${method} ${route} (${response.status})`);
      return response;
    }
    async function start() {
      child = spawn(process.execPath, ['dist/index.js'], {cwd:runtime, env, stdio:'ignore'});
      let spawnError; child.on('error', () => { spawnError = true; });
      let ready = false;
      for (let i = 0; i < 100; i++) {
        if (spawnError || child.exitCode !== null) throw Error('Native entrypoint exited before readiness');
        try { await call('/login'); ready = true; break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      if (!ready) throw Error('Native dashboard did not become ready');
      cookie = (await call('/api/session', 'POST', {username:'smoke', password})).headers.get('set-cookie').split(';')[0];
    }
    await start();
    const edition = await (await call('/api/edition')).json();
    if (edition.edition !== manifest.edition || edition.multiDevice !== false) throw Error('Incorrect native edition or unlicensed fallback');
    const version = await (await call('/api/version?waitForMaestro=false')).json();
    if (version.version !== manifest.version) throw Error('Native version metadata is not used by the runtime');
    if (version.edition !== manifest.edition || version.coreVersion !== manifest.coreVersion ||
        JSON.stringify(version.revisions) !== JSON.stringify(manifest.revisions)) throw Error('Native source metadata differs from the manifest');
    for (const route of ['/api-docs', '/api/mcp-client', '/cli/install.sh']) await call(route);
    const enabled = await (await call('/api/admin/maintenance', 'PUT', {requested:true})).json();
    if (enabled.state !== 'ready') throw Error('Empty native farm did not drain');
    const flows = path.join(temp, 'flows'); fs.mkdirSync(path.join(flows, 'e2e/scenarios'), {recursive:true});
    fs.writeFileSync(path.join(flows, 'e2e/scenarios/native.yaml'), 'appId: com.example.android.contactmanager\n---\n- launchApp\n');
    const flowArchive = path.join(temp, 'flows.tar.gz');
    execFileSync('tar', ['-czf', flowArchive, '-C', flows, 'e2e']);
    const apk = fs.readFileSync(path.resolve(__dirname, '../../tests/fixtures/ContactManager.apk'));
    const upload = new FormData();
    upload.set('flows', '["native"]'); upload.set('env', '{"E2E_LABEL":"native-restart"}');
    upload.set('apk', new Blob([apk]), 'test.apk');
    upload.set('flowsArchive', new Blob([fs.readFileSync(flowArchive)]), 'flows.tar.gz');
    const accepted = await fetch(base + '/run', {method:'POST', headers:{Authorization:`Bearer ${token}`}, body:upload, signal:AbortSignal.timeout(15000)});
    if (accepted.status !== 202) throw Error(`Native queued submission failed (${accepted.status})`);
    const job = await accepted.json();
    fs.rmSync(flows, {recursive:true}); fs.unlinkSync(flowArchive);
    await stop(); await start();
    const recovered = await (await call('/api/maintenance')).json();
    if (!recovered.requested || recovered.state !== 'ready') throw Error('Maintenance did not survive native restart');
    const queued = await fetch(base + '/api/jobs/' + job.id, {headers:{Authorization:`Bearer ${token}`}, signal:AbortSignal.timeout(5000)});
    if (!queued.ok || (await queued.json()).job.status !== 'queued') throw Error('Native queued job did not survive restart');
    const inputs = path.join(data, 'job-inputs', job.id);
    if (!fs.readFileSync(path.join(inputs, 'app.apk')).equals(apk) ||
        JSON.parse(fs.readFileSync(path.join(inputs, 'manifest.json'))).env.E2E_LABEL !== 'native-restart') throw Error('Native queued execution payload was lost');
    const devices = await (await call('/api/devices')).json();
    if (!devices.stale || !devices.devices[0].setupChecks.every(check => check.ok === null)) throw Error('Maintenance device status must be cached');
    if ((await (await call('/api/admin/maintenance', 'PUT', {requested:false})).json()).state !== 'normal') throw Error('Native resume failed');
    console.log(`Extracted ${manifest.edition} native archive passed startup, assets, edition, version and queued payload/maintenance restart/resume`);
  } finally { await stop(); fs.rmSync(temp, {recursive:true, force:true}); }
}
module.exports = {smoke};
if (require.main === module) smoke(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
