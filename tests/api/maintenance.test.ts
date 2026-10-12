import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { openDatabase, type Db } from '../../src/db/driver';
import { migrate } from '../../src/db/migrations';
import { JobRepository } from '../../src/store/jobRepository';
import { MaintenanceCoordinator } from '../../src/maintenance/coordinator';
import { maintenanceRoutes } from '../../src/api/maintenance';

let dir: string, db: Db, gate: MaintenanceCoordinator;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-api-')); db = openDatabase(path.join(dir, 'db')); migrate(db); gate = new MaintenanceCoordinator(new JobRepository(db)); });
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
function app(admin = false) { const a = express(); a.use(express.json()); a.use((req, _res, next) => { req.isAdmin = admin; req.userId = 1; next(); }); a.use(maintenanceRoutes(gate)); return a; }
test('only administrators can change maintenance and malformed requests cannot resume it', async () => {
  expect((await request(app()).put('/api/admin/maintenance').send({ requested: true })).status).toBe(403);
  const admin = app(true);
  expect((await request(admin).put('/api/admin/maintenance').send({ requested: true })).body.state).toBe('ready');
  for (const body of [{}, { requested: 'false' }, { requested: null }]) expect((await request(admin).put('/api/admin/maintenance').send(body)).status).toBe(400);
  expect((await request(app()).get('/api/maintenance')).body.requested).toBe(true);
  expect((await request(admin).put('/api/admin/maintenance').send({ requested: false })).body.state).toBe('normal');
});
