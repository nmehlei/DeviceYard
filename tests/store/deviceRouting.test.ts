import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openDatabase, type Db} from '../../src/db/driver';
import {migrate} from '../../src/db/migrations';
import {JobRepository} from '../../src/store/jobRepository';
import {DeviceRepository} from '../../src/store/deviceRepository';
import {parseDeviceTags} from '../../shared/deviceTags';

let dir: string, db: Db, jobs: JobRepository, devices: DeviceRepository;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-'));
  db = openDatabase(path.join(dir, 'farm.db')); migrate(db);
  jobs = new JobRepository(db); devices = new DeviceRepository(db); devices.seedIfEmpty('phone');
});
afterEach(() => {db.close(); fs.rmSync(dir, {recursive: true, force: true});});

test.each([null, 'tablet', ['Tablet'], ['-tablet'], ['a','a'], ['a'.repeat(33)], Array.from({length:17}, (_,i) => `a${i}`)])('reject invalid tags: %j', value => {
  expect(() => parseDeviceTags(value)).toThrow();
});
test('requirements and audited tags survive restart; Community skips constrained jobs', () => {
  devices.setTags('phone', ['camera', 'android-14'], 'user:1');
  const constrained = jobs.createJob('org', ['a'], undefined, undefined, undefined, undefined, ['tablet']);
  const plain = jobs.createJob('org', ['b']);
  db.close(); db = openDatabase(path.join(dir, 'farm.db')); migrate(db);
  jobs = new JobRepository(db); devices = new DeviceRepository(db);
  expect(devices.get('phone')?.tags).toEqual(['camera','android-14']);
  expect(devices.listEvents('phone')[0]).toMatchObject({kind:'tags', detail: expect.stringContaining('user:1')});
  expect(jobs.getJob(constrained.id)?.requiredDeviceTags).toEqual(['tablet']);
  expect(jobs.claimNextQueued('phone', true)?.id).toBe(plain.id);
  expect(jobs.getJob(constrained.id)?.status).toBe('queued');
});
test('selected claims are atomic and honor maintenance, enrollment and busy devices', () => {
  const a = jobs.createJob('org',['a']); const b = jobs.createJob('org',['b']);
  jobs.setMaintenanceRequested(true);
  expect(jobs.claimQueuedJob(a.id,'phone')).toBeUndefined();
  jobs.setMaintenanceRequested(false); devices.disable('phone');
  expect(jobs.claimQueuedJob(a.id,'phone')).toBeUndefined();
  devices.enable('phone'); expect(jobs.claimQueuedJob(a.id,'phone')?.id).toBe(a.id);
  expect(jobs.claimQueuedJob(a.id,'phone')).toBeUndefined();
  expect(jobs.claimQueuedJob(b.id,'phone')).toBeUndefined();
  expect(jobs.getJob(b.id)?.status).toBe('queued');
});
test('invalid requirements never create a partial job', () => {
  expect(() => jobs.createJob('org',['a'],undefined,undefined,undefined,undefined,['BAD'])).toThrow();
  expect(jobs.listJobs('org')).toEqual([]);
});
