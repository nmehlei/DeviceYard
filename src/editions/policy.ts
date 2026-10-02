import type { DeviceRepository } from '../store/deviceRepository';
import type { JobRepository } from '../store/jobRepository';

export interface EditionSnapshot {
  edition: 'community' | 'pro';
  state: 'community' | 'active' | 'grace' | 'expired' | 'invalid';
  multiDevice: boolean;
  selectedDeviceId: string | null;
  expiresAt?: number;
  graceEndsAt?: number;
}

export interface DevicePolicy {
  snapshot(): EditionSnapshot;
  canUse(id: string): boolean;
  reserve?(id: string): (() => void) | undefined;
  select(id: string): void;
  installLicense?(raw: string): void;
}

export class CommunityPolicy implements DevicePolicy {
  private operations = new Map<string, number>();
  reserve(id: string): (() => void) | undefined {
    if (!this.canUse(id)) return undefined;
    this.operations.set(id, (this.operations.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.operations.get(id) ?? 1) - 1;
      if (remaining) this.operations.set(id, remaining);
      else this.operations.delete(id);
    };
  }
  constructor(protected devices: DeviceRepository, protected jobs: JobRepository,
    protected occupied: () => string[] = () => []) {
    // Fresh installs are seeded after schema migration; initialise once here.
    devices.initializeCommunitySelection();
  }
  snapshot(): EditionSnapshot {
    return { edition:'community', state:'community', multiDevice:false, selectedDeviceId:this.devices.communityDeviceId() };
  }
  canUse(id: string): boolean {
    const selected = this.snapshot().selectedDeviceId;
    return selected === id && !this.jobs.runningDeviceIds().some(d => d !== id)
      && !this.occupied().some(d => d !== id)
      && ![...this.operations.keys()].some(d => d !== id);
  }
  select(id: string): void {
    if (!this.devices.get(id)) throw new Error('UNKNOWN_DEVICE');
    if (id === this.devices.communityDeviceId()) return;
    if (this.jobs.runningCount() > 0 || this.occupied().length > 0 || this.operations.size > 0) throw new Error('DEVICE_BUSY');
    // Synchronous SQLite call, no await between the check and selection.
    this.devices.selectCommunityDevice(id);
  }
}
