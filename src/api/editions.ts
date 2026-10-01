import {Router} from 'express';
import type {DevicePolicy} from '../editions/policy';
import type {DeviceRepository} from '../store/deviceRepository';
export function editionRoutes(deps:{policy:DevicePolicy;deviceRepo:DeviceRepository;dispatch:()=>void;blockedReason?:()=>string|null}):Router {
  const router=Router();
  router.get('/api/edition',(_req,res)=>res.json({...deps.policy.snapshot(),blockedReason:deps.blockedReason?.() ?? null}));
  router.post('/api/edition/device',(req,res)=>{
    if(!req.isAdmin) {res.status(403).json({error:'admin access required'});return;}
    if(typeof req.body?.deviceId!=='string') {res.status(400).json({error:'deviceId is required'});return;}
    try {
      deps.policy.select(req.body.deviceId);
      deps.deviceRepo.recordEvent(req.body.deviceId,'enabled','selected as Community fallback by administrator');
      deps.dispatch();res.json(deps.policy.snapshot());
    } catch(err) {const code=err instanceof Error?err.message:'SELECTION_FAILED';res.status(code==='UNKNOWN_DEVICE'?404:409).json({error:code,code});}
  });
  router.post('/api/edition/license',(req,res)=>{
    if(!req.isAdmin) {res.status(403).json({error:'admin access required'});return;}
    if(!deps.policy.installLicense) {res.status(409).json({error:'Install the Pro build to use a Pro license',code:'PRO_BUILD_REQUIRED'});return;}
    if(typeof req.body?.license!=='string'||Buffer.byteLength(req.body.license)>16384) {res.status(400).json({error:'INVALID_LICENSE',code:'INVALID_LICENSE'});return;}
    try {deps.policy.installLicense(req.body.license);deps.dispatch();res.json(deps.policy.snapshot());}
    catch {res.status(400).json({error:'License could not be installed. The previous license remains unchanged.',code:'LICENSE_INSTALL_FAILED'});}
  });
  return router;
}
