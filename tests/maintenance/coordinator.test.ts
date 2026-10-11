import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type Db } from '../../src/db/driver';
import { migrate } from '../../src/db/migrations';
import { JobRepository } from '../../src/store/jobRepository';
import { DeviceRepository } from '../../src/store/deviceRepository';
import { SingleDeviceScheduler } from '../../src/editions/singleDeviceScheduler';
import { MaintenanceCoordinator } from '../../src/maintenance/coordinator';

let dir: string, db: Db, repo: JobRepository, gate: MaintenanceCoordinator;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-')); db = openDatabase(path.join(dir, 'db')); migrate(db); new DeviceRepository(db).seedIfEmpty('phone'); repo = new JobRepository(db); gate = new MaintenanceCoordinator(repo); });
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
test('maintenance guards atomic claims and survives reopening the database', () => {
  const first = repo.createJob('org', ['flow']);
  gate.setRequested(true); gate.setRequested(true);
  expect(repo.claimNextQueued('phone')).toBeUndefined();
  db.close(); db = openDatabase(path.join(dir, 'db')); repo = new JobRepository(db); gate = new MaintenanceCoordinator(repo);
  expect(gate.snapshot().state).toBe('ready'); expect(repo.claimNextQueued('phone')).toBeUndefined();
  gate.setRequested(false); expect(repo.claimNextQueued('phone')?.id).toBe(first.id);
});
test('readiness includes job cleanup after the row becomes terminal', async () => {
  const job = repo.createJob('org', ['flow']); repo.claimNextQueued('phone');
  let finish!: () => void;
  const running = gate.trackClaimedJob(job.id, () => new Promise<void>(resolve => { finish = resolve; }));
  gate.setRequested(true);
  expect(gate.snapshot()).toMatchObject({ state: 'draining', runningJobs: 1 });
  repo.finishJob(job.id, 'done');
  expect(gate.snapshot()).toMatchObject({ state: 'draining', runningJobs: 1 });
  finish(); await running; expect(gate.snapshot().state).toBe('ready');
});
test('operations and streams drain independently and release idempotently even across resume', () => {
  const release = gate.acquire('operation')!, stream = gate.acquire('stream')!;
  gate.setRequested(true); expect(gate.acquire('operation')).toBeUndefined();
  expect(gate.snapshot()).toMatchObject({ state: 'draining', activeOperations: 1, activeStreams: 1 });
  gate.setRequested(false); gate.setRequested(true); release(); release();
  expect(gate.snapshot().state).toBe('draining'); stream(); expect(gate.snapshot().state).toBe('ready');
});
test('an online probe finishing after enable cannot claim queued work', async () => {
  const devices = new DeviceRepository(db); devices.seedIfEmpty('phone');
  let answer!: (online: boolean) => void;
  const job = repo.createJob('org', ['flow']);
  const scheduler = new SingleDeviceScheduler({ repo, deviceRepo: devices, tickMs: 0,
    isDeviceOnline: () => new Promise(resolve => { answer = resolve; }), runJob: async () => {} });
  scheduler.dispatch(); gate.setRequested(true); answer(true);
  await new Promise(resolve => setImmediate(resolve));
  expect(repo.getJob(job.id)?.status).toBe('queued');
  const probe = jest.fn(async () => true);
  const paused = new SingleDeviceScheduler({ repo, deviceRepo: devices, tickMs: 0, isDeviceOnline: probe, runJob: async () => {} });
  paused.dispatch(); expect(probe).not.toHaveBeenCalled(); scheduler.stop(); paused.stop();
});
