"use client";
import { useEffect, useRef, useState } from 'react';
import { fetchMaintenance, setMaintenance, type MaintenanceStatus } from '../lib/api';

/** One request at a time; a late poll must never overwrite a button response. */
export function MaintenanceCard({ readOnly = false }: { readOnly?: boolean }) {
  const [status, setStatus] = useState<MaintenanceStatus>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const changing = useRef(false), revision = useRef(0);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const version = revision.current;
      try {
        if (!changing.current) {
          const next = await fetchMaintenance();
          if (alive && revision.current === version) { setStatus(next); setError(''); }
        }
      } catch { if (alive) setError('Could not refresh maintenance status'); }
      finally { if (alive) timer = setTimeout(poll, 3000); }
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, []);
  const change = async () => {
    if (!status || changing.current) return;
    changing.current = true; revision.current++; setBusy(true); setError('');
    try { setStatus(await setMaintenance(!status.requested)); }
    catch { setError('Could not change maintenance mode'); }
    finally { changing.current = false; setBusy(false); }
  };
  if (readOnly && !status?.requested) return null;
  const title = !status ? 'Loading maintenance status…' : status.state === 'normal' ? 'Normal operation' : status.state === 'draining' ? 'Draining' : 'Ready for maintenance';
  return <section className="ui-card settings-config-card" aria-label="Maintenance mode">
    <h2>Maintenance mode</h2>
    <p role="status">{title}</p>
    {status?.requested && <>
      <p>{status.runningJobs} running jobs · {status.activeOperations} device operations · {status.activeStreams} streams</p>
      <p>New jobs wait in the queue. Device status is cached during maintenance.</p>
    </>}
    {!readOnly && <>
      <p>Let running jobs finish and pause new device activity. Queued jobs survive restarts; external CI deadlines still apply.</p>
      <button className="ui-button" disabled={!status || busy} onClick={() => void change()}>{status?.requested ? 'Resume' : 'Enable maintenance'}</button>
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
