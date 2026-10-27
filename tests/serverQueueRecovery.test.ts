import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import request from 'supertest';
import { createServer } from '../src/server';
import { openDatabase } from '../src/db/driver';
import { migrate } from '../src/db/migrations';
import { JobRepository } from '../src/store/jobRepository';
import { DeviceRepository } from '../src/store/deviceRepository';
import { UserRepository } from '../src/store/userRepository';
import { OrgRepository } from '../src/store/orgRepository';
import { OrgTokenRepository } from '../src/store/orgTokenRepository';
import { UserTokenRepository } from '../src/store/userTokenRepository';
import { defaultRunner, type CommandRunner } from '../src/maestro';

test('a queued upload executes after the server and database reopen without its temporary uploads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-recovery-'));
  const uploadDir = path.join(dir, 'tmp'); fs.mkdirSync(uploadDir);
  const source = path.join(dir, 'source'); fs.mkdirSync(path.join(source, 'e2e/scenarios'), { recursive: true });
  fs.writeFileSync(path.join(source, 'e2e/scenarios/test.yaml'), 'appId: example.app\n---\n- launchApp\n');
  const archive = path.join(dir, 'flows.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', source, 'e2e']);
  const dataDir = path.join(dir, 'data');
  let db = openDatabase(path.join(dataDir, 'farm.db')); migrate(db);
  const deps = () => ({ repo: new JobRepository(db), deviceRepo: new DeviceRepository(db),
    userRepo: new UserRepository(db), orgRepo: new OrgRepository(db),
    orgTokenRepo: new OrgTokenRepository(db, '0'.repeat(64)), userTokenRepo: new UserTokenRepository(db, '0'.repeat(64)) });
  let stores = deps();
  const admin = stores.userRepo.create({ username: 'admin', email: 'a@example.com', password: 'test', isAdmin: true });
  const org = stores.orgRepo.create('test', [admin.id]);
  stores.orgTokenRepo.create(org.id, 'test', 'queue-test-token', admin.id);
  stores.deviceRepo.seedIfEmpty('test-phone');
  const common = { dataDir, uploadDir, deviceId: 'test-phone', sessionSecret: 'test',
    resolveAppId: async () => ({ appId: 'example.app', appVersion: null }) };
  let app = createServer({ ...stores, ...common, scheduler: { submit: () => {} } });
  try {
    expect((await request(app).get('/api/maintenance')).status).toBe(401);
    expect((await request(app).put('/api/admin/maintenance').send({ requested: true })).status).toBe(401);
    app.maintenance.setRequested(true);
    const submitted = await request(app).post('/run').set('Authorization', 'Bearer queue-test-token')
      .field('flows', '["test"]').field('env', '{"E2E_LABEL":"restart-value"}')
      .attach('apk', Buffer.from('apk-content'), 'test.apk').attach('flowsArchive', archive);
    expect(submitted.status).toBe(202);
    await app.control.close(); db.close();
    fs.rmSync(uploadDir, { recursive: true }); fs.mkdirSync(uploadDir);
    db = openDatabase(path.join(dataDir, 'farm.db')); migrate(db); stores = deps();
    let installed = false; let receivedEnv = false;
    const runner: CommandRunner = async (file, args) => {
      if (file === 'tar') return defaultRunner(file, args);
      if (file === 'adb' && args.includes('install')) installed = fs.readFileSync(args[args.length - 1], 'utf8') === 'apk-content';
      if (file === 'maestro') receivedEnv ||= args.includes('E2E_LABEL=restart-value');
      return { code: 0, stdout: args.includes('devices') ? 'List of devices attached\ntest-phone\tdevice\n' : args.includes('get-state') ? 'device' : 'ok', stderr: '' };
    };
    app = createServer({ ...stores, ...common, runner });
    app.scheduler.dispatch?.();
    await new Promise(resolve => setImmediate(resolve));
    expect(stores.repo.getJob(submitted.body.id)?.status).toBe('queued');
    expect(app.maintenance.snapshot().state).toBe('ready');
    app.maintenance.setRequested(false);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && ['queued', 'running'].includes(stores.repo.getJob(submitted.body.id)!.status))
      await new Promise(resolve => setTimeout(resolve, 20));
    expect(stores.repo.getJob(submitted.body.id)?.status).toBe('done');
    expect(installed).toBe(true); expect(receivedEnv).toBe(true);
  } finally {
    app.scheduler.stop?.();
    try {
      // A terminal job row precedes asynchronous input cleanup. Drain the
      // tracked operation before closing its database or deleting its files.
      app.maintenance.setRequested(true);
      const deadline = Date.now() + 10000;
      while (app.maintenance.snapshot().state !== 'ready' && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 20));
      expect(app.maintenance.snapshot().state).toBe('ready');
    } finally {
      await app.control.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}, 30000);
