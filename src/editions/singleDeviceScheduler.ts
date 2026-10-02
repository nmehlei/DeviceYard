import { log } from '../telemetry/log';
import type { SchedulerDeps, SchedulerHandle } from './scheduler';
import { CommunityPolicy } from './policy';

export class SingleDeviceScheduler implements SchedulerHandle {
  private timer?: NodeJS.Timeout;
  private readonly policy;
  private checking = false;
  private stopped = false;
  private offlineDevice?: string;
  constructor(private readonly deps: SchedulerDeps) {
    this.policy=deps.policy ?? new CommunityPolicy(deps.deviceRepo,deps.repo,deps.occupiedDeviceIds);
    const tick=deps.tickMs ?? 10000;
    if(tick>0) { this.timer=setInterval(()=>this.dispatch(),tick); this.timer.unref(); }
  }
  submit(_id:string):void { this.dispatch(); }
  busyDevices():string[] { return this.deps.repo.runningDeviceIds(); }
  stop():void { this.stopped=true; if(this.timer) clearInterval(this.timer); this.timer=undefined; }
  blockedReason(): string | null {
    const id = this.policy.snapshot().selectedDeviceId;
    if (!id) return 'COMMUNITY_DEVICE_REQUIRED';
    if (!this.deps.deviceRepo.get(id)?.isActive || this.offlineDevice === id) return 'COMMUNITY_DEVICE_UNAVAILABLE';
    if (this.deps.repo.runningCount() || !this.policy.canUse(id) || this.deps.occupiedDeviceIds?.().length) return 'COMMUNITY_DEVICE_BUSY';
    return null;
  }
  dispatch():void {
    if (this.stopped) return;
    const id = this.policy.snapshot().selectedDeviceId;
    if (!id || this.checking) return;
    if (!this.deps.isDeviceOnline) { this.claim(id); return; }
    if (this.deps.repo.runningCount() || !this.deps.deviceRepo.get(id)?.isActive) return;
    this.checking = true;
    void this.deps.isDeviceOnline(id).catch(() => false).then(online => {
      if (this.stopped) return;
      this.offlineDevice = online ? undefined : id;
      // Selection and entitlement may change while ADB answers; claim rechecks both.
      if (online && this.policy.snapshot().selectedDeviceId === id) this.claim(id);
    }).finally(() => { this.checking = false; });
  }
  private claim(id: string):void {
    if (this.stopped) return;
    const {repo,deviceRepo}=this.deps;
    if(repo.runningCount()>0) return;
    if(!id || !this.policy.canUse(id) || !deviceRepo.get(id)?.isActive) return;
    if(this.deps.occupiedDeviceIds?.().length) return;
    const cap=repo.getSchedulerSettings()?.maxConcurrentJobs;
    if(cap!==null && cap!==undefined && cap<=0) return;
    const job=repo.claimNextQueued(id,true);
    if(!job) return;
    Promise.resolve().then(()=>this.deps.runJob({jobId:job.id,deviceId:id}))
      .catch(err=>{
        log.error('job could not be started',{jobId:job.id,deviceId:id});
        try { repo.finishJob(job.id,'failed',err instanceof Error?err.message:String(err)); }
        catch { log.error('could not record job start failure',{jobId:job.id}); }
        this.deps.onJobStartFailed?.(job.id,err);
      }).finally(()=>this.dispatch());
  }
}
