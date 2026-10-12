import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { openDatabase, type Db } from '../../src/db/driver';
import { migrate } from '../../src/db/migrations';
import { JobRepository } from '../../src/store/jobRepository';
import { DeviceRepository } from '../../src/store/deviceRepository';
import { MaintenanceCoordinator } from '../../src/maintenance/coordinator';
import { deviceRoutes } from '../../src/api/devices';
import { NotificationStore } from '../../src/notifications/store';
import { DeviceHealthMonitor } from '../../src/notifications/health';
import { trackControlStream } from '../../src/maintenance/control';
import { fakeStream } from '../helpers/fakeControlStream';
import { ControlStartupError } from '../../src/control/controlStream';

let dir: string, db: Db, repo: JobRepository, devices: DeviceRepository, gate: MaintenanceCoordinator;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-access-')); db = openDatabase(path.join(dir, 'db')); migrate(db); repo = new JobRepository(db); devices = new DeviceRepository(db); devices.seedIfEmpty('phone'); gate = new MaintenanceCoordinator(repo); });
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
test('maintenance returns stored device data and rejects hardware actions without starting ADB', async () => {
  const runner = jest.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
  const app = express(); app.use(express.json()); app.use(deviceRoutes({ repo, deviceRepo: devices, runner, maintenance: gate }));
  gate.setRequested(true);
  const list = await request(app).get('/api/devices');
  expect(list.status).toBe(200); expect(list.body.stale).toBe(true);
  expect(list.body.devices[0]).toMatchObject({ id: 'phone', state: 'unknown' });
  const reboot = await request(app).post('/api/devices/phone/reboot');
  expect(reboot.status).toBe(503); expect(reboot.body.code).toBe('MAINTENANCE_MODE');
  expect((await request(app).get('/api/devices/phone/screenshot')).status).toBe(503);
  expect(runner).not.toHaveBeenCalled();
});
test('a finite operation admitted before maintenance remains counted until it finishes', async () => {
  let finish!: () => void;
  const runner = () => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => { finish = () => resolve({ code: 0, stdout: '', stderr: '' }); });
  const app = express(); app.use(express.json()); app.use(deviceRoutes({ repo, deviceRepo: devices, runner, maintenance: gate }));
  const pending = request(app).post('/api/devices/phone/reboot').then(r => r);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  gate.setRequested(true); expect(gate.snapshot()).toMatchObject({ state: 'draining', activeOperations: 1 });
  finish(); expect((await pending).status).toBe(202); expect(gate.snapshot().state).toBe('ready');
});
test('maintenance skips health observations and counts a probe already in flight', async () => {
  const store = new NotificationStore(db, 'ab'.repeat(32));
  let finish!: (states: Map<string, boolean>) => void;
  const probe = jest.fn(() => new Promise<Map<string, boolean>>(resolve => { finish = resolve; }));
  const monitor = new DeviceHealthMonitor(store, probe, gate);
  gate.setRequested(true); await monitor.tick(); expect(probe).not.toHaveBeenCalled();
  expect(db.all('SELECT * FROM notification_incidents')).toHaveLength(0);
  gate.setRequested(false); const pending = monitor.tick(); gate.setRequested(true);
  expect(gate.snapshot().state).toBe('draining'); finish(new Map()); await pending;
  expect(gate.snapshot().state).toBe('ready');
  expect(db.all('SELECT * FROM notification_incidents')).toHaveLength(0);
});
test('a late stream stays counted until its process exits even if close returns early', async () => {
  const fake = fakeStream();
  let started!: (value: typeof fake.stream) => void;
  const start = trackControlStream(gate, () => new Promise(resolve => { started = resolve; }));
  const pending = start('phone'); gate.setRequested(true);
  expect(gate.snapshot()).toMatchObject({ state: 'draining', activeStreams: 1 });
  started({ ...fake.stream, close: async () => {} });
  const stream = await pending; await stream.close();
  expect(gate.snapshot().state).toBe('draining'); fake.die();
  await new Promise(resolve => setImmediate(resolve)); expect(gate.snapshot().state).toBe('ready');
  await expect(start('phone')).rejects.toMatchObject({ code: 'MAINTENANCE_MODE' });
});

test('failed startup with an unconfirmed device process cannot report ready', async () => {
  const start = trackControlStream(gate, async () => { throw new ControlStartupError('unconfirmed exit'); });
  await expect(start('phone')).rejects.toThrow('unconfirmed exit');
  gate.setRequested(true);
  expect(gate.snapshot()).toMatchObject({ state: 'draining', activeStreams: 1 });
});

test('failed startup releases its lease only after confirmed process exit', async () => {
  let exited!: () => void;
  const closed = new Promise<void>(resolve => { exited = resolve; });
  const start = trackControlStream(gate, async () => { throw new ControlStartupError('failed handshake', closed); });
  await expect(start('phone')).rejects.toThrow('failed handshake');
  gate.setRequested(true);
  expect(gate.snapshot().state).toBe('draining');
  exited(); await new Promise(resolve => setImmediate(resolve));
  expect(gate.snapshot()).toMatchObject({ state: 'ready', activeStreams: 0 });
});

test('failure before launching a device process releases its lease', async () => {
  const start = trackControlStream(gate, async () => { throw new Error('device unavailable'); });
  await expect(start('phone')).rejects.toThrow('device unavailable');
  gate.setRequested(true);
  expect(gate.snapshot()).toMatchObject({ state: 'ready', activeStreams: 0 });
});
