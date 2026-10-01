import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import { createControlUpgrade } from "../../src/api/control";
import { ControlHub } from "../../src/control/hub";
import { ControlLeases } from "../../src/control/leases";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { UserRepository } from "../../src/store/userRepository";
import { DeviceRepository } from "../../src/store/deviceRepository";
import { signSession } from "../../src/session";
import type {DevicePolicy} from '../../src/editions/policy';
import {fakeStream} from '../helpers/fakeControlStream';

const SESSION_SECRET = "test-secret-at-least-32-characters-long";

let dir: string;
let db: Db;
let userRepo: UserRepository;
let deviceRepo: DeviceRepository;
let server: http.Server;
let control: ReturnType<typeof createControlUpgrade>;
let port: number;
let adminId: number;
let memberId: number;
let allowHardware=true;
let policyNow=0;
let leases: ControlLeases;

/**
 * Opens a socket and settles with either the open event or the HTTP status the
 * server refused the upgrade with. Every path settles and every path has a
 * bound: a hang here would stall the whole suite rather than fail a test.
 */
function connect(pathname: string, cookie?: string): Promise<{ opened: boolean; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`, {
      headers: cookie ? { cookie } : {},
    });
    const done = (r: { opened: boolean; status?: number }) => {
      clearTimeout(guard);
      resolve(r);
    };
    const guard = setTimeout(() => {
      ws.terminate();
      done({ opened: false, status: -1 });
    }, 2000);
    ws.on("open", () => {
      ws.close();
      done({ opened: true });
    });
    ws.on("unexpected-response", (_req, res) => {
      ws.terminate();
      done({ opened: false, status: res.statusCode });
    });
    ws.on("error", () => done({ opened: false }));
  });
}

const cookieFor = (userId: number) =>
  `mdf_session=${signSession(userId, Date.now() + 60_000, SESSION_SECRET)}`;

beforeEach(async () => {
  allowHardware=true; policyNow=0; leases=new ControlLeases();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-control-auth-"));
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  userRepo = new UserRepository(db);
  deviceRepo = new DeviceRepository(db);

  adminId = userRepo.create({ username: "admin", email: "ad@example.com", password: "x", isAdmin: true }).id;
  memberId = userRepo.create({ username: "member", email: "me@example.com", password: "x", isAdmin: false }).id;
  deviceRepo.add("dev-1", "Test device");

  control = createControlUpgrade({
    now:()=>policyNow,
    policy:{canUse:()=>allowHardware,snapshot:()=>({edition:'community',state:'community',multiDevice:false,selectedDeviceId:'dev-1'}),select:()=>{}} satisfies DevicePolicy,
    userRepo,
    deviceRepo,
    sessionSecret: SESSION_SECRET,
    hub: new ControlHub({
      createSource: () => ({ start: () => {}, stop: () => {} }),
      isDeviceBusy: () => false,
      leases,
      startControlStream: async () => fakeStream().stream,
      hasWaitingJobFor: () => undefined,
      onControlReleased: () => {},
    }),
  });

  server = http.createServer((_req, res) => res.end());
  server.on("upgrade", (req, socket, head) => control.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  control.close();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("refuses an unauthenticated upgrade with 401", async () => {
  expect(await connect("/api/devices/dev-1/control")).toEqual({ opened: false, status: 401 });
});

test('edition policy refuses hardware socket even for administrator',async()=>{
  allowHardware=false;
  try{expect(await connect('/api/devices/dev-1/control',cookieFor(adminId))).toEqual({opened:false,status:409});}
  finally{allowHardware=true;}
});

test("refuses an authenticated non-admin with 403, not 401", async () => {
  // Distinct on purpose: conflating the two sends an org member to re-login
  // forever over a permission they will never have.
  expect(await connect("/api/devices/dev-1/control", cookieFor(memberId))).toEqual({ opened: false, status: 403 });
});

test("refuses a deactivated admin with 401", async () => {
  const ghost = userRepo.create({ username: "ghost", email: "g@example.com", password: "x", isAdmin: true });
  userRepo.deactivate(ghost.id);
  expect(await connect("/api/devices/dev-1/control", cookieFor(ghost.id))).toEqual({ opened: false, status: 401 });
});

test("refuses an unknown device with 404 for an admin", async () => {
  expect(await connect("/api/devices/nope/control", cookieFor(adminId))).toEqual({ opened: false, status: 404 });
});

test("checks authentication before the device exists, so device ids do not leak", async () => {
  // An unauthenticated caller must not be able to tell a real device id from
  // a made-up one by comparing 401 against 404.
  expect(await connect("/api/devices/nope/control")).toEqual({ opened: false, status: 401 });
});

test("accepts an admin on a known device", async () => {
  expect(await connect("/api/devices/dev-1/control", cookieFor(adminId))).toEqual({ opened: true });
});
test('idle expired socket warns, terminates after five minutes and releases its control lease',async()=>{
  const ws=new WebSocket(`ws://127.0.0.1:${port}/api/devices/dev-1/control`,{headers:{cookie:cookieFor(adminId)}});
  const message=(type:string)=>new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(`No ${type} message`)),3500);
    const receive=(data:Buffer)=>{const value=JSON.parse(data.toString());if(value.type===type&&(type!=='mode'||value.inControl)){clearTimeout(timer);ws.off('message',receive);resolve();}};
    ws.on('message',receive);
  });
  try {
    await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
    const acquired=message('mode');ws.send(JSON.stringify({type:'take-control'}));await acquired;
    expect(leases.get('dev-1')).toBeDefined();
    const warning=message('edition-warning');allowHardware=false;await warning;
    expect(ws.readyState).toBe(WebSocket.OPEN);
    const closed=new Promise<void>(resolve=>ws.once('close',()=>resolve()));
    policyNow=300000;await closed;
    await new Promise(resolve=>setImmediate(resolve));
    expect(leases.get('dev-1')).toBeUndefined();
  } finally {ws.terminate();allowHardware=true;}
},8000);
