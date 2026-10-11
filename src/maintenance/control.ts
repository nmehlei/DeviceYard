import type { StartControlStream } from '../control/controlStream';
import { MaintenanceCoordinator, MaintenanceError } from './coordinator';
import { log } from '../telemetry/log';

/** Admission includes startup and teardown, even when the hub times out. */
export function trackControlStream(gate: MaintenanceCoordinator, start: StartControlStream): StartControlStream {
  return async id => {
    const release = gate.acquire('stream');
    if (!release) throw new MaintenanceError();
    let stream;
    try { stream = await start(id); } catch (err) { release(); throw err; }
    // Only confirmed process exit releases the lease. A failed teardown must
    // remain visibly draining, not falsely advertise readiness.
    void stream.closed.then(release, () => log.error('control stream exit could not be confirmed', { deviceId: id }));
    return stream;
  };
}
