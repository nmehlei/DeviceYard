import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobInputsStore } from '../../src/store/jobInputs';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inputs-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
function inputs() {
  const apkPath = path.join(dir, 'source.apk'), flowsArchivePath = path.join(dir, 'source.tar');
  fs.writeFileSync(apkPath, 'apk'); fs.writeFileSync(flowsArchivePath, 'flows');
  return { appId: 'example.app', apkPath, flowsArchivePath, env: { LABEL: 'persisted' } };
}
test('publishes private inputs atomically and reads only store-derived paths after restart', async () => {
  const store = new JobInputsStore(dir);
  await store.save('job-1', inputs());
  const loaded = await new JobInputsStore(dir).load('job-1');
  expect(loaded?.env).toEqual({ LABEL: 'persisted' });
  expect(fs.readFileSync(loaded!.apkPath, 'utf8')).toBe('apk');
  expect(fs.statSync(path.dirname(loaded!.apkPath)).mode & 0o777).toBe(0o700);
  expect(fs.statSync(path.join(path.dirname(loaded!.apkPath), 'manifest.json')).mode & 0o777).toBe(0o600);
  await store.remove('job-1'); expect(await store.load('job-1')).toBeUndefined();
});
test('a partial save is not runnable and cannot overwrite existing inputs', async () => {
  const store = new JobInputsStore(dir), value = inputs();
  await expect(store.save('partial', { ...value, flowsArchivePath: path.join(dir, 'missing') })).rejects.toThrow();
  expect(await store.load('partial')).toBeUndefined();
  await store.save('existing', value);
  await expect(store.save('existing', value)).rejects.toThrow();
  expect((await store.load('existing'))?.appId).toBe('example.app');
});
test('rejects path traversal and malformed manifests without echoing their contents', async () => {
  const store = new JobInputsStore(dir);
  await expect(store.save('../escape', inputs())).rejects.toThrow('invalid job id');
  await store.save('broken', inputs());
  const loaded = await store.load('broken');
  fs.writeFileSync(path.join(path.dirname(loaded!.apkPath), 'manifest.json'), '{bad-json');
  await expect(store.load('broken')).rejects.toThrow('job inputs unavailable');
});
test('startup cleanup retains queued and running inputs but removes abandoned staging and terminal jobs', async () => {
  const store = new JobInputsStore(dir);
  for (const id of ['queued', 'running', 'terminal', 'orphan']) await store.save(id, inputs());
  fs.mkdirSync(path.join(dir, 'job-inputs', '.staging-abandoned'));
  await store.reconcile(id => ['queued', 'running'].includes(id));
  expect(await store.load('queued')).toBeDefined(); expect(await store.load('running')).toBeDefined();
  expect(await store.load('terminal')).toBeUndefined(); expect(await store.load('orphan')).toBeUndefined();
  expect(fs.existsSync(path.join(dir, 'job-inputs', '.staging-abandoned'))).toBe(false);
});
