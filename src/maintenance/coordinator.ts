import type { JobRepository } from '../store/jobRepository';
import { log } from '../telemetry/log';

export interface MaintenanceStatus {
  requested: boolean;
  state: 'normal' | 'draining' | 'ready';
  runningJobs: number;
  activeOperations: number;
  activeStreams: number;
}
export class MaintenanceError extends Error {
  readonly code = 'MAINTENANCE_MODE';
  constructor() { super('device access paused for maintenance'); }
}
export class MaintenanceCoordinator {
  private operations = 0;
  private streams = 0;
  private jobs = new Set<string>();
  private listeners = new Set<(requested: boolean) => void>();
  private lastState: MaintenanceStatus['state'] = 'normal';
  constructor(private readonly repo: JobRepository) {}
  get requested(): boolean { return this.repo.isMaintenanceRequested(); }
  onChange(listener: (requested: boolean) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  setRequested(requested: boolean): void {
    const changed = this.requested !== requested;
    this.repo.setMaintenanceRequested(requested);
    if (changed) for (const listener of this.listeners) listener(requested);
    this.snapshot();
  }
  snapshot(): MaintenanceStatus {
    const runningJobs = new Set([...this.repo.runningJobIds(), ...this.jobs]).size;
    const requested = this.requested;
    const state = !requested ? 'normal' : runningJobs + this.operations + this.streams > 0 ? 'draining' : 'ready';
    if (state !== this.lastState) { this.lastState = state; log.info('maintenance_state_changed', { state }); }
    return { requested, state, runningJobs, activeOperations: this.operations, activeStreams: this.streams };
  }
  acquire(kind: 'operation' | 'stream'): (() => void) | undefined {
    if (this.requested) return undefined;
    if (kind === 'operation') this.operations++; else this.streams++;
    let released = false;
    return () => {
      if (released) return; released = true;
      if (kind === 'operation') this.operations--; else this.streams--;
      this.snapshot();
    };
  }
  async run<T>(kind: 'operation' | 'stream', action: () => Promise<T>): Promise<T> {
    const release = this.acquire(kind);
    if (!release) throw new MaintenanceError();
    try { return await action(); } finally { release(); }
  }
  async trackClaimedJob<T>(jobId: string, run: () => Promise<T>): Promise<T> {
    this.jobs.add(jobId);
    try { return await run(); } finally { this.jobs.delete(jobId); this.snapshot(); }
  }
}
