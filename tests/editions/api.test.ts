import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import {openDatabase,Db} from '../../src/db/driver';
import {migrate} from '../../src/db/migrations';
import {DeviceRepository} from '../../src/store/deviceRepository';
import {JobRepository} from '../../src/store/jobRepository';
import {CommunityPolicy} from '../../src/editions/policy';
import {editionRoutes} from '../../src/api/editions';
import {deviceRoutes} from '../../src/api/devices';
let dir:string,db:Db,devices:DeviceRepository,jobs:JobRepository,policy:CommunityPolicy;
beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'edition-api-'));db=openDatabase(path.join(dir,'db'));migrate(db);devices=new DeviceRepository(db);jobs=new JobRepository(db);devices.seedIfEmpty('a');policy=new CommunityPolicy(devices,jobs);devices.add('b','b');});
afterEach(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
function app(admin=true){const a=express();a.use(express.json());a.use((req,_res,next)=>{req.isAdmin=admin;next();});a.use(editionRoutes({policy,deviceRepo:devices,dispatch:()=>{}}));a.use(deviceRoutes({repo:jobs,deviceRepo:devices,policy,runner:async()=>({code:0,stdout:'',stderr:''})}));return a;}
test('second device enable and legacy activate are denied server-side',async()=>{
  for(const verb of ['enable','activate']) {const r=await request(app()).post(`/api/devices/b/${verb}`);expect(r.status).toBe(409);expect(r.body.code).toBe('PRO_REQUIRED');}
  expect(devices.get('b')?.isActive).toBe(false);
});
test('inactive-device screenshot/reboot cannot bypass Community',async()=>{
  expect((await request(app()).get('/api/devices/b/screenshot')).status).toBe(409);
  expect((await request(app()).post('/api/devices/b/reboot')).status).toBe(409);
});
test('Express trailing slash and case aliases preserve hardware policy',async()=>{
  for (const suffix of ['screenshot/', 'SCREENSHOT']) expect((await request(app()).get(`/api/devices/b/${suffix}`)).status).toBe(409);
  for (const suffix of ['reboot/', 'REBOOT', 'reset-policy/', 'RESET-POLICY']) expect((await request(app()).post(`/api/devices/b/${suffix}`)).status).toBe(409);
});
test('selection waits for in-flight hardware work even when the request is asynchronous',async()=>{
  let finish!: (value: Buffer) => void;
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const a = express(); a.use(express.json());
  a.use((req,_res,next)=>{req.isAdmin=true;next();});
  a.use(editionRoutes({policy,deviceRepo:devices,dispatch:()=>{}}));
  a.use(deviceRoutes({repo:jobs,deviceRepo:devices,policy,captureScreenshot:()=>{started();return new Promise<Buffer>(resolve=>{finish=resolve;});}}));
  const pending = request(a).get('/api/devices/a/screenshot').then(r=>r);
  await began;
  expect((await request(a).post('/api/edition/device').send({deviceId:'b'})).status).toBe(409);
  finish(Buffer.from('png')); expect((await pending).status).toBe(200);
  expect((await request(a).post('/api/edition/device').send({deviceId:'b'})).status).toBe(200);
});
test('selection and license installation require an administrator',async()=>{
  expect((await request(app(false)).post('/api/edition/device').send({deviceId:'b'})).status).toBe(403);
  expect((await request(app(false)).post('/api/edition/license').send({license:'anything'})).status).toBe(403);
  const r=await request(app()).post('/api/edition/device').send({deviceId:'b'});expect(r.status).toBe(200);expect(policy.canUse('b')).toBe(true);
  expect((await request(app()).post('/api/devices/b/enable')).status).toBe(200);
  expect(devices.get('a')).toBeDefined();
});
test('history stays readable and edition status never contains raw license',async()=>{
  expect((await request(app()).get('/api/devices/a/events')).status).toBe(200);
  const r=await request(app()).get('/api/edition');expect(r.status).toBe(200);expect(r.body.selectedDeviceId).toBe('a');expect(r.body).not.toHaveProperty('license');
});
