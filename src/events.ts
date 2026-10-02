import { EventEmitter } from "events";
import { log } from "./telemetry/log";

/**
 * Per-job change notifications for SSE. One process, one queue, so an
 * EventEmitter is genuinely sufficient - no broker, no fan-out across hosts.
 */
export class JobEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    // A busy job page can hold more than the default ten listeners; the limit
    // exists to catch leaks, and unsubscribe below is what prevents those.
    this.emitter.setMaxListeners(0);
  }

  publish(jobId: string): void {
    // A throwing listener must never propagate out of publish(). runJob calls
    // this synchronously from inside its own try block, AFTER persisting a
    // terminal "done" - so an uncaught throw here lands in runJob's catch,
    // which re-runs cleanup and overwrites the job as "failed". A passing CI
    // run would flip to failed and push DonableApp's pipeline onto a paid
    // device-cloud fallback for no real reason. Isolate each listener instead:
    // one subscriber's bug must never affect the publisher or any other
    // subscriber.
    for (const listener of this.emitter.listeners(jobId)) {
      try {
        (listener as () => void)();
      } catch (err) {
        log.error("job event listener threw", { jobId, err: String(err) });
      }
    }
  }

  subscribe(jobId: string, listener: () => void): () => void {
    this.emitter.on(jobId, listener);
    return () => this.emitter.off(jobId, listener);
  }
}
