import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import request from 'supertest';
import {WebSocket} from 'ws';
import SwaggerParser from '@apidevtools/swagger-parser';
import {createServer, type ServerHandle} from '../../src/server';
import {buildOpenApiDocument} from '../../src/openapi/document';
import {openDatabase, type Db} from '../../src/db/driver';
import {migrate} from '../../src/db/migrations';
import {JobRepository} from '../../src/store/jobRepository';
import {DeviceRepository} from '../../src/store/deviceRepository';
import {UserRepository} from '../../src/store/userRepository';
import {OrgRepository} from '../../src/store/orgRepository';
import {OrgTokenRepository} from '../../src/store/orgTokenRepository';
import {UserTokenRepository} from '../../src/store/userTokenRepository';
import {communityRuntime} from '../../src/editions/runtime';
import type {IsolationHooks} from '../../src/editions/isolation';
import {signSession} from '../../src/session';
import {fakeStream} from '../helpers/fakeControlStream';

const WARNING = 'per-flow isolation creates a work profile for every flow: about 15-40 s and 1.5 GB of device writes per flow';
const SESSION_SECRET = 'test-secret-at-least-32-characters-long';

let dir: string, db: Db, app: ServerHandle, jobs: JobRepository;
let enabled = false;
let expireDuringStore = false;
let enabledCalls = 0;
let useCallCount = false;
let adminCookie: string;
const token = randomBytes(24).toString('hex');
const hooks = (): IsolationHooks => ({
  enabled: () => {
    if (useCallCount) return ++enabledCalls === 1;
    return enabled;
  },
  createScope: async () => { throw new Error('not used'); },
  removeScope: async () => [],
  maestro: () => ({file: '', testArgs: []}),
});
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isolation-api-'));
  fs.mkdirSync(path.join(dir, 'uploads'));
  db = openDatabase(path.join(dir, 'farm.db')); migrate(db); jobs = new JobRepository(db);
  const devices = new DeviceRepository(db); devices.seedIfEmpty('phone');
  const users = new UserRepository(db), orgs = new OrgRepository(db);
  const key = randomBytes(32).toString('hex');
  const tokens = new OrgTokenRepository(db, key), pats = new UserTokenRepository(db, key);
  const user = users.create({username: 'admin', email: 'admin@example.com', password: randomBytes(16).toString('hex'), isAdmin: true});
  adminCookie = `mdf_session=${signSession(user.id, Date.now() + 60_000, SESSION_SECRET)}`;
  const org = orgs.create('test', [user.id]); tokens.create(org.id, 'test', token, user.id);
  enabled = false; expireDuringStore = false; enabledCalls = 0; useCallCount = false;
  app = createServer({repo: jobs, deviceRepo: devices, userRepo: users, orgRepo: orgs, orgTokenRepo: tokens, userTokenRepo: pats,
    sessionSecret: SESSION_SECRET, deviceId: 'phone', dataDir: dir, uploadDir: path.join(dir, 'uploads'),
    scheduler: {submit: () => {}}, schedulerTickMs: 0, startControlStream: async () => fakeStream().stream,
    resolveAppId: async () => ({appId: 'example.app', appVersion: null}),
    editionFactory: ctx => ({...communityRuntime(ctx), isolation: hooks()})});
});
afterEach(async () => {app.scheduler.stop?.(); await app.control.close(); db.close(); fs.rmSync(dir, {recursive: true, force: true});});
const submit = (value?: string) => {
  const req = request(app).post('/run').set('Authorization', `Bearer ${token}`)
    .attach('apk', Buffer.from('fixture'), 'app.apk').attach('flowsArchive', Buffer.from('fixture'), 'flows.tar.gz').field('flows', '["test"]');
  return value === undefined ? req : req.field('isolation', value);
};
const uploads = () => fs.readdirSync(path.join(dir, 'uploads'));

test('isolation omitted runs as disabled, and the 202 body has no warnings key', async () => {
  const response = await submit();
  expect(response.status).toBe(202);
  expect(response.body).not.toHaveProperty('warnings');
  expect(jobs.getJob(response.body.id)?.isolation).toBe('disabled');
});
test('isolation "per-job" without edition isolation is 403 PRO_ISOLATION_REQUIRED and leaves no upload on disk', async () => {
  const response = await submit('per-job');
  expect(response.status).toBe(403);
  expect(response.body.code).toBe('PRO_ISOLATION_REQUIRED');
  expect(jobs.listJobs('test')).toEqual([]);
  expect(uploads()).toEqual([]);
});
test('isolation "per-flow" with isolation enabled is accepted, persisted, and warns about the cost', async () => {
  enabled = true;
  const response = await submit('per-flow');
  expect(response.status).toBe(202);
  expect(response.body.warnings).toEqual([WARNING]);
  expect(jobs.getJob(response.body.id)?.isolation).toBe('per-flow');
  enabled = true;
  const perJob = await submit('per-job');
  expect(perJob.status).toBe(202);
  expect(perJob.body).not.toHaveProperty('warnings');
});
test('an invalid isolation value is 400 naming the allowed values', async () => {
  enabled = true;
  const response = await submit('sometimes');
  expect(response.status).toBe(400);
  expect(response.body.error).toContain('disabled, per-job, per-flow');
  expect(jobs.listJobs('test')).toEqual([]);
  expect(uploads()).toEqual([]);
});
test('entitlement lost during input storage rejects the isolated job and removes its inputs', async () => {
  useCallCount = true;
  const response = await submit('per-job');
  expect(response.status).toBe(403);
  expect(response.body.code).toBe('PRO_ISOLATION_REQUIRED');
  expect(enabledCalls).toBe(2);
  expect(jobs.listJobs('test')).toEqual([]);
  expect(uploads()).toEqual([]);
});
test('a queued isolated job reports PRO_ISOLATION_REQUIRED when the scheduler has no waiting-reason hook', async () => {
  enabled = true;
  const response = await submit('per-job');
  enabled = false;
  const detail = await request(app).get(`/api/jobs/${response.body.id}`).set('Authorization', `Bearer ${token}`);
  expect(detail.body.job).toMatchObject({isolation: 'per-job', waitingReason: 'PRO_ISOLATION_REQUIRED'});
});
test('the control-lease handover never offers an isolated job on Community', async () => {
  jobs.createJob('test', ['a/a'], undefined, 'example.app', null, undefined, [], 'per-job');
  const server = app.listen(0);
  server.on('upgrade', (req, socket, head) => app.control.handleUpgrade(req, socket, head));
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as import('net').AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/devices/phone/control`, {headers: {cookie: adminCookie}});
  const messages: any[] = [];
  ws.on('message', (data, isBinary) => {if (!isBinary) messages.push(JSON.parse(String(data)));});
  const until = async (pred: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !pred()) await new Promise(r => setTimeout(r, 50));
  };
  try {
    await new Promise<void>((resolve, reject) => {ws.once('open', () => resolve()); ws.once('error', reject);});
    await until(() => messages.some(m => m.type === 'mode'), 3000);
    ws.send(JSON.stringify({type: 'take-control'}));
    await until(() => messages.some(m => m.type === 'mode' && m.mode === 'live-control' && m.inControl), 3000);
    await new Promise(r => setTimeout(r, 2500));
    expect(messages.some(m => m.type === 'release-pending')).toBe(false);
    // Sanity: a plain waiting job does start the countdown.
    jobs.createJob('test', ['b/b']);
    await until(() => messages.some(m => m.type === 'release-pending'), 4000);
    expect(messages.some(m => m.type === 'release-pending')).toBe(true);
  } finally {
    ws.close();
    await new Promise(r => setTimeout(r, 150));
    await new Promise(resolve => server.close(resolve));
  }
}, 20000);
test('the OpenAPI document lists isolation on the run request and job schema, and validates', async () => {
  const doc: any = buildOpenApiDocument();
  const field = doc.paths['/run'].post.requestBody.content['multipart/form-data'].schema.properties.isolation;
  expect(field.enum).toEqual(['disabled', 'per-job', 'per-flow']);
  expect(field.description).toContain('`per-job` costs about 15–40 s and about 1.5 GB of device writes per job; `per-flow` costs that for every flow (a 27-flow suite writes about 40 GB).');
  expect(doc.components.schemas.Job.properties.isolation.enum).toEqual(['disabled', 'per-job', 'per-flow']);
  expect(doc.components.schemas.Step.properties.profileMs.type).toEqual(['integer', 'null']);
  expect(doc.paths['/run'].post.responses[202].content['application/json'].schema.properties.warnings).toMatchObject({type: 'array', items: {type: 'string'}});
  await expect(SwaggerParser.validate(JSON.parse(JSON.stringify(doc)))).resolves.toBeDefined();
});
