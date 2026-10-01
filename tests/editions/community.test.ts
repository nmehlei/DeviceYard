import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, Db } from '../../src/db/driver';
import { migrate } from '../../src/db/migrations';
import { DeviceRepository } from '../../src/store/deviceRepository';
import { JobRepository } from '../../src/store/jobRepository';
import { CommunityPolicy } from '../../src/editions/policy';
import { SingleDeviceScheduler } from '../../src/editions/singleDeviceScheduler';

let dir: string, db: Db, devices: DeviceRepository, jobs: JobRepository;
beforeEach(() => { dir=fs.mkdtempSync(path.join(os.tmpdir(),'editions-')); db=openDatabase(path.join(dir,'db')); migrate(db); devices=new DeviceRepository(db); jobs=new JobRepository(db); });
afterEach(() => { db.close(); fs.rmSync(dir,{recursive:true,force:true}); });
function enroll(id:string) { devices.add(id,id); devices.enable(id); }
test('shutdown cancels pending connectivity claims and ignores later dispatch',async()=>{
  enroll('a');const policy=new CommunityPolicy(devices,jobs);
  const job=jobs.createJob('org',['flow']);let answer!:(online:boolean)=>void;
  const runJob=jest.fn(async()=>{});
  const s=new SingleDeviceScheduler({repo:jobs,deviceRepo:devices,policy,tickMs:0,isDeviceOnline:()=>new Promise(resolve=>{answer=resolve;}),runJob});
  s.dispatch();s.stop();answer(true);
  await new Promise(resolve=>setImmediate(resolve));
  s.dispatch();
  expect(jobs.getJob(job.id)?.status).toBe('queued');expect(runJob).not.toHaveBeenCalled();
});
test('offline fallback leaves FIFO queued and resumes after reconnect',async()=>{
  enroll('a'); const policy=new CommunityPolicy(devices,jobs);
  const first=jobs.createJob('org',['flow']);
  let online=false;
  const s=new SingleDeviceScheduler({repo:jobs,deviceRepo:devices,policy,tickMs:0,isDeviceOnline:async()=>online,runJob:()=>new Promise<void>(()=>{})});
  s.dispatch(); await new Promise(resolve=>setImmediate(resolve));
  expect(jobs.getJob(first.id)?.status).toBe('queued');
  expect(s.blockedReason()).toBe('COMMUNITY_DEVICE_UNAVAILABLE');
  online=true;s.dispatch();await new Promise(resolve=>setImmediate(resolve));
  expect(jobs.getJob(first.id)?.status).toBe('running');s.stop();
});
test('connectivity check cannot claim a device after the selection changes',async()=>{
  enroll('a'); const policy=new CommunityPolicy(devices,jobs);enroll('b');
  const job=jobs.createJob('org',['flow']);let answer!:(online:boolean)=>void;
  const s=new SingleDeviceScheduler({repo:jobs,deviceRepo:devices,policy,tickMs:0,isDeviceOnline:()=>new Promise(resolve=>{answer=resolve;}),runJob:async()=>{}});
  s.dispatch();policy.select('b');answer(true);await new Promise(resolve=>setImmediate(resolve));
  expect(jobs.getJob(job.id)?.status).toBe('queued');s.stop();
});
test('multiple old enrollments require explicit choice and persist selection across restart',()=>{
  enroll('a'); enroll('b'); const policy=new CommunityPolicy(devices,jobs);
  expect(policy.snapshot().selectedDeviceId).toBeNull();
  policy.select('b'); expect(policy.canUse('a')).toBe(false); expect(policy.canUse('b')).toBe(true);
  expect(new CommunityPolicy(devices,jobs).snapshot().selectedDeviceId).toBe('b');
  expect(devices.list()).toHaveLength(2);
});
test('only selected device runs and reentrant dispatch cannot start another job',async()=>{
  enroll('a'); const policy=new CommunityPolicy(devices,jobs); enroll('b');
  const first=jobs.createJob('org',['flow']), second=jobs.createJob('org',['flow']);
  const runJob=jest.fn(()=>new Promise<void>(()=>{}));
  const s=new SingleDeviceScheduler({repo:jobs,deviceRepo:devices,policy,runJob,tickMs:0});
  s.dispatch(); s.dispatch(); await Promise.resolve();
  expect(runJob).toHaveBeenCalledTimes(1); expect(jobs.getJob(first.id)?.deviceId).toBe('a');
  expect(jobs.getJob(second.id)?.status).toBe('queued'); s.stop();
});
test('pooled jobs drain before fallback work and selection refuses active work',()=>{
  enroll('a'); enroll('b'); const policy=new CommunityPolicy(devices,jobs); policy.select('a');
  const first=jobs.createJob('org',['flow']); jobs.claimNextQueued('b');
  const second=jobs.createJob('org',['flow']);
  const s=new SingleDeviceScheduler({repo:jobs,deviceRepo:devices,policy,runJob:async()=>{},tickMs:0});
  s.dispatch(); expect(jobs.getJob(second.id)?.status).toBe('queued');
  expect(()=>policy.select('b')).toThrow('DEVICE_BUSY');
  jobs.finishJob(first.id,'done'); policy.select('b'); expect(policy.canUse('a')).toBe(false); s.stop();
});
test('manual sessions prevent switching and stale rows cannot change the selected device',()=>{
  enroll('a'); enroll('b'); const policy=new CommunityPolicy(devices,jobs,()=>['a']);
  expect(()=>policy.select('b')).toThrow('DEVICE_BUSY');
});
test('atomic single-device claim guards every running job',()=>{
  enroll('a'); jobs.createJob('org',['flow']); jobs.claimNextQueued('a');
  const second=jobs.createJob('org',['flow']); expect(jobs.claimNextQueued('b',true)).toBeUndefined();
  expect(jobs.getJob(second.id)?.status).toBe('queued');
});
test('removing selected device never auto-selects a different model on restart',()=>{
  enroll('a');const policy=new CommunityPolicy(devices,jobs);enroll('b');
  devices.disable('a');devices.remove('a');
  expect(policy.snapshot().selectedDeviceId).toBeNull();
  expect(new CommunityPolicy(devices,jobs).snapshot().selectedDeviceId).toBeNull();
});
