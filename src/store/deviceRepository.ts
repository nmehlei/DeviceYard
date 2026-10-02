import type { Db } from "../db/driver";
import { isResetPolicy } from "./rows";
import type { DeviceEventKind, DeviceEventRow, DeviceRow, ResetPolicy } from "./rows";

interface DeviceRecord {
  id: string;
  label: string;
  model: string | null;
  is_active: number;
  added_at: number;
  reset_policy: string;
}

interface DeviceEventRecord {
  id: number;
  device_id: string;
  kind: string;
  detail: string;
  created_at: number;
}

function toDevice(record: DeviceRecord): DeviceRow {
  return {
    id: record.id,
    label: record.label,
    model: record.model,
    isActive: record.is_active === 1,
    addedAt: record.added_at,
    // A row written by a future version, or hand-edited, must not hand an
    // unknown policy to prepareDevice. Fall back to the safe end of the
    // scale rather than trusting the column.
    resetPolicy: isResetPolicy(record.reset_policy) ? record.reset_policy : "app-only",
  };
}

function toEvent(record: DeviceEventRecord): DeviceEventRow {
  return {
    id: record.id,
    deviceId: record.device_id,
    kind: record.kind as DeviceEventKind,
    detail: record.detail,
    createdAt: record.created_at,
  };
}

export class DeviceRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now
  ) {}

  communityDeviceId(): string | null {
    return this.db.get<{ community_device_id: string | null }>(
      "SELECT community_device_id FROM edition_settings WHERE singleton=1"
    )?.community_device_id ?? null;
  }

  selectCommunityDevice(id: string): void {
    this.db.run("UPDATE edition_settings SET community_device_id=?, selection_initialized=1 WHERE singleton=1", id);
  }

  initializeCommunitySelection(): void {
    this.db.run(`UPDATE edition_settings SET
      community_device_id = CASE WHEN (SELECT COUNT(*) FROM devices WHERE is_active=1)=1
        THEN (SELECT id FROM devices WHERE is_active=1 LIMIT 1) ELSE NULL END,
      selection_initialized=1 WHERE singleton=1 AND selection_initialized=0`);
  }

  /**
   * One-time backfill so an existing deployment's single configured device
   * shows up as a row instead of the list starting empty. Only ever inserts
   * when the table is empty - every boot after the first finds a non-empty
   * table and no-ops, so this never re-creates a device an operator removed
   * or fights with rows a later boot's config disagrees with.
   */
  seedIfEmpty(deviceId: string): void {
    const row = this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM devices");
    if ((row?.c ?? 0) > 0) return;
    this.db.run(
      "INSERT INTO devices (id, label, model, is_active, added_at) VALUES (?, ?, NULL, 1, ?)",
      deviceId,
      deviceId,
      this.now()
    );
  }

  list(): DeviceRow[] {
    return this.db
      .all<DeviceRecord>("SELECT * FROM devices ORDER BY is_active DESC, added_at ASC")
      .map(toDevice);
  }

  get(id: string): DeviceRow | undefined {
    const record = this.db.get<DeviceRecord>("SELECT * FROM devices WHERE id = ?", id);
    return record ? toDevice(record) : undefined;
  }

  /**
   * Every device enrolled in the pool, oldest enrolment first so dispatch
   * order is stable across calls rather than whatever SQLite returns.
   *
   * is_active is REINTERPRETED by cycle 10, not migrated: it used to mean
   * "the one device jobs run against" - activate() cleared every other row to
   * enforce that - and now means "enrolled and accepting work". An existing
   * deployment therefore comes up as a pool of one, unchanged.
   */
  listEnrolled(): DeviceRow[] {
    return this.db
      .all<DeviceRecord>("SELECT * FROM devices WHERE is_active = 1 ORDER BY added_at ASC")
      .map(toDevice);
  }

  enable(id: string): void {
    this.db.run("UPDATE devices SET is_active = 1 WHERE id = ?", id);
  }

  /** Drain, not kill: a device running a job finishes it and is simply never
   * claimed again. Nothing here interrupts a running flow. */
  disable(id: string): void {
    this.db.run("UPDATE devices SET is_active = 0 WHERE id = ?", id);
  }

  /** device_events cascades; jobs.device_id is ON DELETE SET NULL, so job
   * history outlives the device it ran on. Callers must check the device is
   * disabled and idle first - this does not. */
  remove(id: string): void {
    this.db.run("DELETE FROM devices WHERE id = ?", id);
  }

  add(id: string, label: string): DeviceRow {
    this.db.run(
      "INSERT INTO devices (id, label, model, is_active, added_at) VALUES (?, ?, NULL, 0, ?)",
      id,
      label,
      this.now()
    );
    return this.get(id)!;
  }

  /**
   * Switching a device to a stronger policy deletes data on the next job, so
   * the caller is expected to record a device event naming who did it. This
   * writes the column only - the audit trail is the API's job, where the
   * acting user is known.
   */
  setResetPolicy(id: string, policy: ResetPolicy): void {
    this.db.run("UPDATE devices SET reset_policy = ? WHERE id = ?", policy, id);
  }

  /** The display name only. The id is the adb serial and never changes. */
  setLabel(id: string, label: string): void {
    this.db.run("UPDATE devices SET label = ? WHERE id = ?", label, id);
  }

  updateModel(id: string, model: string): void {
    this.db.run("UPDATE devices SET model = ? WHERE id = ?", model, id);
  }

  recordEvent(deviceId: string, kind: DeviceEventKind, detail: string): void {
    this.db.run(
      "INSERT INTO device_events (device_id, kind, detail, created_at) VALUES (?, ?, ?, ?)",
      deviceId,
      kind,
      detail,
      this.now()
    );
  }

  listEvents(deviceId: string, limit = 30): DeviceEventRow[] {
    return this.db
      .all<DeviceEventRecord>(
        "SELECT * FROM device_events WHERE device_id = ? ORDER BY id DESC LIMIT ?",
        deviceId,
        limit
      )
      .map(toEvent);
  }
}
