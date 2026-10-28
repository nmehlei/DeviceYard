export type IsolationMode = 'disabled' | 'per-job' | 'per-flow';

export const ISOLATION_MODES: readonly IsolationMode[] = ['disabled', 'per-job', 'per-flow'];

/** Shared validation only; `undefined` means the caller did not ask for isolation. */
export function parseIsolation(value: unknown): IsolationMode {
  if (value === undefined) return 'disabled';
  if (typeof value === 'string' && (ISOLATION_MODES as readonly string[]).includes(value)) {
    return value as IsolationMode;
  }
  throw new Error('isolation must be one of disabled, per-job, per-flow');
}
