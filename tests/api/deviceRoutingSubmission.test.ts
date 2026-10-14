import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {Router} from 'express';
import request from 'supertest';
import {createServer, type ServerHandle} from '../../src/server';
import {openDatabase, type Db} from '../../src/db/driver';
import {migrate} from '../../src/db/migrations';
import {JobRepository} from '../../src/store/jobRepository';
import {DeviceRepository} from '../../src/store/deviceRepository';
import {UserRepository} from '../../src/store/userRepository';
import {OrgRepository} from '../../src/store/orgRepository';
import {OrgTokenRepository} from '../../src/store/orgTokenRepository';
import {UserTokenRepository} from '../../src/store/userTokenRepository';
import {communityRuntime} from '../../src/editions/runtime';

let dir: string, db: Db, app: ServerHandle, jobs: JobRepository;
let enabled = false;
let expireDuringParse = false;
const token = randomBytes(24).toString('hex');
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(),'routing-api-'));
  fs.mkdirSync(path.join(dir,'uploads'));
  db = openDatabase(path.join(dir,'farm.db')); migrate(db); jobs = new JobRepository(db);
  const devices = new DeviceRepository(db); devices.seedIfEmpty('phone');
  const users = new UserRepository(db), orgs = new OrgRepository(db);
  const key = randomBytes(32).toString('hex');
  const tokens = new OrgTokenRepository(db,key), pats = new UserTokenRepository(db,key);
  const user = users.create({username:'admin', email:'admin@example.com', password:randomBytes(16).toString('hex'),isAdmin:true});
  const org = orgs.create('test',[user.id]); tokens.create(org.id,'test',token,user.id);
  enabled = false;
  expireDuringParse = false;
  app = createServer({repo:jobs,deviceRepo:devices,userRepo:users,orgRepo:orgs,orgTokenRepo:tokens,userTokenRepo:pats,
    sessionSecret:randomBytes(32).toString('hex'),deviceId:'phone',dataDir:dir,uploadDir:path.join(dir,'uploads'),
    scheduler:{submit:()=>{}},resolveAppId:async()=>{if(expireDuringParse)enabled=false;return {appId:'example.app',appVersion:null};},
    editionFactory:ctx=>({...communityRuntime(ctx),deviceRouting:{enabled:()=>enabled,routes:Router()}})});
});
afterEach(async () => {app.scheduler.stop?.(); await app.control.close(); db.close(); fs.rmSync(dir,{recursive:true,force:true});});
const submit = (value?: string) => {
  const req = request(app).post('/run').set('Authorization',`Bearer ${token}`)
    .attach('apk',Buffer.from('fixture'),'app.apk').attach('flowsArchive',Buffer.from('fixture'),'flows.tar.gz').field('flows','["test"]');
  return value === undefined ? req : req.field('requiredDeviceTags',value);
};
test.each(['null','{}','invalid','["Tablet"]','["a","a"]','[""]'])('invalid requirements reject without storing a job: %s',async value=>{
  enabled = true;
  expect((await submit(value)).status).toBe(400);
  expect(jobs.listJobs('test')).toEqual([]);
  expect(fs.readdirSync(path.join(dir,'uploads'))).toEqual([]);
});
test('Community rejects constrained jobs but accepts old clients',async()=>{
  expect((await submit('["tablet"]')).status).toBe(403);
  expect(jobs.listJobs('test')).toEqual([]);
  expect((await submit()).status).toBe(202);
  expect(jobs.listJobs('test')[0].requiredDeviceTags).toEqual([]);
});
test('enabled routing persists requirements and returns them in scoped details',async()=>{
  enabled = true;
  const response = await submit('["tablet","camera"]');
  expect(response.status).toBe(202);
  expect(jobs.getJob(response.body.id)?.requiredDeviceTags).toEqual(['tablet','camera']);
  enabled = false;
  const detail = await request(app).get(`/api/jobs/${response.body.id}`).set('Authorization',`Bearer ${token}`);
  expect(detail.body.job).toMatchObject({requiredDeviceTags:['tablet','camera'],waitingReason:'PRO_ROUTING_REQUIRED'});
});
test('expiry while resolving the APK rejects and cleans up prepared inputs',async()=>{
  enabled=true;expireDuringParse=true;
  expect((await submit('["tablet"]')).status).toBe(403);
  expect(jobs.listJobs('test')).toEqual([]);
  expect(fs.readdirSync(path.join(dir,'uploads'))).toEqual([]);
});
