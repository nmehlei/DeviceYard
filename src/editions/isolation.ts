export interface IsolationScope { userId: number; name: string; warnings: string[]; durationMs: number }

export class IsolationError extends Error {
  constructor(message: string, readonly output: string) {
    super(message);
    this.name = 'IsolationError';
  }
}

export interface IsolationHooks {
  enabled(): boolean;
  /** Every job, isolated or not, right after prepareDevice. Pro removes leftover farm profiles. Returns warnings. */
  beforeJob?(deviceId: string): Promise<string[]>;
  /** Create, start and return a profile. Throws IsolationError (with the adb output) on any failure. */
  createScope(input: { deviceId: string; jobId: string; ordinal?: number }): Promise<IsolationScope>;
  /** Never throws; returns warnings. */
  removeScope(deviceId: string, scope: IsolationScope): Promise<string[]>;
  maestro(scope: IsolationScope): { file: string; testArgs: string[] };
}
