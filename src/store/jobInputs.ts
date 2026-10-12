import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';

export interface QueuedJobInputs {
  appId: string;
  apkPath: string;
  flowsArchivePath: string;
  env?: Record<string, string>;
}

/** Private execution payloads, never served by artifact or job APIs. */
export class JobInputsStore {
  private readonly root: string;
  constructor(dataDir: string) { this.root = path.join(dataDir, 'job-inputs'); }
  private directory(id: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error('invalid job id');
    return path.join(this.root, id);
  }
  async save(id: string, inputs: QueuedJobInputs): Promise<void> {
    const target = this.directory(id);
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const staging = await fs.mkdtemp(path.join(this.root, '.staging-'));
    try {
      for (const [source, name] of [[inputs.apkPath, 'app.apk'], [inputs.flowsArchivePath, 'flows.tar.gz']]) {
        const dest = path.join(staging, name);
        await fs.copyFile(source, dest);
        await fs.chmod(dest, 0o600);
      }
      await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify({ appId: inputs.appId, env: inputs.env }), { mode: 0o600, flag: 'wx' });
      // A complete existing directory cannot be replaced by rename. The job
      // row is inserted only after this atomic publication succeeds.
      await fs.rename(staging, target);
    } catch {
      await fs.rm(staging, { recursive: true, force: true });
      throw new Error('could not persist job inputs');
    }
  }
  async load(id: string): Promise<QueuedJobInputs | undefined> {
    const dir = this.directory(id);
    try { await fs.lstat(dir); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('job inputs unavailable');
    }
    try {
      const value = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
      if (!value || typeof value.appId !== 'string' || !value.appId ||
        (value.env !== undefined && (!value.env || Array.isArray(value.env) || typeof value.env !== 'object' ||
          Object.values(value.env).some(v => typeof v !== 'string')))) throw new Error();
      const apkPath = path.join(dir, 'app.apk'), flowsArchivePath = path.join(dir, 'flows.tar.gz');
      for (const file of [apkPath, flowsArchivePath]) if (!(await fs.lstat(file)).isFile()) throw new Error();
      return { appId: value.appId, env: value.env, apkPath, flowsArchivePath };
    } catch { throw new Error('job inputs unavailable'); }
  }
  async remove(id: string): Promise<void> { await fs.rm(this.directory(id), { recursive: true, force: true }); }
  /** Startup only, before submissions or dispatch; a single server owns DATA_DIR. */
  reconcile(retain: (id: string) => boolean): void {
    let names: string[];
    try { names = syncFs.readdirSync(this.root); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const name of names) {
      if (name.startsWith('.staging-') || (/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(name) && !retain(name)))
        syncFs.rmSync(path.join(this.root, name), { recursive: true, force: true });
    }
  }
  hasPayload(id: string): boolean {
    return ['manifest.json', 'app.apk', 'flows.tar.gz'].every(name => syncFs.existsSync(path.join(this.directory(id), name)));
  }
}
