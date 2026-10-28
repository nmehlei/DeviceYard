import fs from "fs";
import os from "os";
import path from "path";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { JobRepository } from "../../src/store/jobRepository";
import { DeviceRepository } from "../../src/store/deviceRepository";
import { ISOLATION_MODES, parseIsolation } from "../../shared/isolation";

let dir: string;
let db: Db;
let jobs: JobRepository;
let devices: DeviceRepository;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-isolation-"));
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  jobs = new JobRepository(db);
  devices = new DeviceRepository(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('parseIsolation accepts the three modes, defaults undefined to disabled, rejects anything else', () => {
  expect(ISOLATION_MODES.map(parseIsolation)).toEqual(['disabled', 'per-job', 'per-flow']);
  expect(parseIsolation(undefined)).toBe('disabled');
  for (const bad of ['Per-Job', 'perjob', '', null, 1, 'per-flow ']) {
    expect(() => parseIsolation(bad)).toThrow('isolation must be one of disabled, per-job, per-flow');
  }
});

test('a job keeps its isolation mode, and an existing job reads as disabled', () => {
  const isolated = jobs.createJob('donable', ['a'], undefined, null, null, undefined, [], 'per-flow');
  expect(jobs.getJob(isolated.id)?.isolation).toBe('per-flow');
  const plain = jobs.createJob('donable', ['a']);
  expect(jobs.getJob(plain.id)?.isolation).toBe('disabled');
});

test('finishStep stores profileMs, and steps without it read null', () => {
  const job = jobs.createJob('donable', ['a', 'b']);
  const [a, b] = jobs.getSteps(job.id).filter(s => s.kind === 'flow');
  const started = jobs.startStep(job.id, a.name);
  expect(jobs.finishStep(started.id, { status: 'passed', profileMs: 1234 }).profileMs).toBe(1234);
  const other = jobs.startStep(job.id, b.name);
  expect(jobs.finishStep(other.id, { status: 'passed' }).profileMs).toBeNull();
});

test('isolation capability is unknown until recorded, then true/false/unknown', () => {
  devices.add('R1', 'one');
  const read = () => devices.list().find(d => d.id === 'R1')?.isolationCapable;
  expect(read()).toBeNull();
  devices.setIsolationCapable('R1', true);
  expect(read()).toBe(true);
  devices.setIsolationCapable('R1', false);
  expect(read()).toBe(false);
  devices.setIsolationCapable('R1', null);
  expect(read()).toBeNull();
});

test('the single-device claim never takes an isolated job', () => {
  devices.add('R1', 'one');
  const isolated = jobs.createJob('donable', ['a'], undefined, null, null, undefined, [], 'per-job');
  const plain = jobs.createJob('donable', ['a']);
  expect(jobs.claimNextQueued('R1', true)?.id).toBe(plain.id);
  expect(jobs.getJob(isolated.id)?.status).toBe('queued');
});
