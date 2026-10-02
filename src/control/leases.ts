export interface LeaseHolder {
  userId: number;
  username: string;
}

export interface Lease {
  deviceId: string;
  holder: LeaseHolder;
  acquiredAt: number;
  lastSeenAt: number;
  /** Set when a job is waiting: the moment control is taken away. */
  releaseAt?: number;
  waitingJobId?: string;
}

export type AcquireResult = { ok: true; lease: Lease } | { ok: false; heldBy: string };

/** Spec D-4: 30s backstop for a half-open socket. The socket closing is the
 * primary release signal; this only covers a connection that died silently. */
const DEFAULT_TTL_MS = 30_000;
/** Spec D-5: long enough to finish a thought, short enough that a forgotten
 * tab costs CI one minute. */
const DEFAULT_GRACE_MS = 60_000;

/**
 * Who is driving which device. In memory ONLY, deliberately.
 *
 * The scheduler derives free-ness on every pass and never leases, so a crashed
 * process strands nothing (src/scheduler.ts). A control session is inherently
 * a lease, so it lives here with a TTL rather than in SQLite: if the process
 * dies, every lease dies with it and every device is free again.
 *
 * No timers and no clock of its own - every method takes `now`, so the hub's
 * tick drives it and tests can walk time forward exactly.
 */
export class ControlLeases {
  private readonly leases = new Map<string, Lease>();
  private readonly ttlMs: number;
  private readonly graceMs: number;

  constructor(opts: { ttlMs?: number; graceMs?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  }

  acquire(deviceId: string, holder: LeaseHolder, now: number): AcquireResult {
    const existing = this.leases.get(deviceId);
    if (existing && existing.holder.userId !== holder.userId) {
      return { ok: false, heldBy: existing.holder.username };
    }
    if (existing) {
      existing.lastSeenAt = now;
      return { ok: true, lease: existing };
    }
    const lease: Lease = { deviceId, holder, acquiredAt: now, lastSeenAt: now };
    this.leases.set(deviceId, lease);
    return { ok: true, lease };
  }

  release(deviceId: string, userId: number): boolean {
    const lease = this.leases.get(deviceId);
    if (!lease || lease.holder.userId !== userId) return false;
    this.leases.delete(deviceId);
    return true;
  }

  /** Heartbeat. Ignored from anyone but the holder: a watcher's pong must not
   * keep somebody else's abandoned session alive. */
  touch(deviceId: string, userId: number, now: number): void {
    const lease = this.leases.get(deviceId);
    if (lease && lease.holder.userId === userId) lease.lastSeenAt = now;
  }

  /** Idempotent: a queue that stays busy must not keep restarting the clock,
   * or the release it is waiting for would never arrive. */
  beginRelease(deviceId: string, jobId: string, now: number): number | undefined {
    const lease = this.leases.get(deviceId);
    if (!lease) return undefined;
    if (lease.releaseAt === undefined) {
      lease.releaseAt = now + this.graceMs;
      lease.waitingJobId = jobId;
    }
    return lease.releaseAt;
  }

  cancelRelease(deviceId: string): boolean {
    const lease = this.leases.get(deviceId);
    if (!lease || lease.releaseAt === undefined) return false;
    delete lease.releaseAt;
    delete lease.waitingJobId;
    return true;
  }

  /** Devices whose lease should end now: silent past the TTL, or past a
   * release deadline. Touching does not rescue a lease that is counting down. */
  expired(now: number): string[] {
    const out: string[] = [];
    for (const [deviceId, lease] of this.leases) {
      const silent = now - lease.lastSeenAt >= this.ttlMs;
      const deadline = lease.releaseAt !== undefined && now >= lease.releaseAt;
      if (silent || deadline) out.push(deviceId);
    }
    return out;
  }

  get(deviceId: string): Lease | undefined {
    return this.leases.get(deviceId);
  }

  /** Exposed so ControlHub can enforce, at construction, that its start
   * timeout is strictly smaller than this grace period - the design (D-5) is
   * only safe if a countdown always has time to fire before a start that's
   * merely slow gets mistaken for one that's hung. */
  get graceMsValue(): number {
    return this.graceMs;
  }

  occupiedDeviceIds(): string[] {
    return [...this.leases.keys()];
  }
}
