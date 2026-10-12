import { Router } from 'express';
import type { MaintenanceCoordinator } from '../maintenance/coordinator';
import { log } from '../telemetry/log';

/** Mounted behind the server's existing authentication middleware. */
export function maintenanceRoutes(maintenance: MaintenanceCoordinator): Router {
  const router = Router();
  router.get('/api/maintenance', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.json(maintenance.snapshot());
  });
  router.put('/api/admin/maintenance', (req, res) => {
    if (!req.isAdmin) { res.status(403).json({ error: 'admin access required' }); return; }
    if (typeof req.body?.requested !== 'boolean') { res.status(400).json({ error: 'requested must be a boolean' }); return; }
    const requested: boolean = req.body.requested;
    maintenance.setRequested(requested);
    log.info('maintenance_requested', { actorId: req.userId, requested });
    res.setHeader('Cache-Control', 'no-store'); res.json(maintenance.snapshot());
  });
  return router;
}
