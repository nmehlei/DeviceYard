import type { JobRepository } from '../store/jobRepository';
import type { DeviceRepository } from '../store/deviceRepository';
import type { DevicePolicy } from './policy';
export interface SchedulerDeps {
  repo: JobRepository;
  deviceRepo: DeviceRepository;
  runJob: (opts: {jobId:string; deviceId:string}) => Promise<void>;
  onJobStartFailed?: (jobId:string, err:unknown) => void;
  tickMs?: number;
  occupiedDeviceIds?: () => string[];
  policy?: DevicePolicy;
  isDeviceOnline?: (id: string) => Promise<boolean>;
}
export interface SchedulerHandle {
  submit(jobId:string): void;
  dispatch(): void;
  busyDevices(): string[];
  stop(): void;
  blockedReason?(): string | null;
  jobWaitingReason?(jobId: string): string | null;
  waitingJobFor?(deviceId: string): string | undefined;
}
