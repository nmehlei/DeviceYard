import {CommunityPolicy,DevicePolicy} from './policy';
import {SingleDeviceScheduler} from './singleDeviceScheduler';
import type {SchedulerDeps,SchedulerHandle} from './scheduler';
import type {DeviceRepository} from '../store/deviceRepository';
import type {JobRepository} from '../store/jobRepository';
import type {IsolationHooks} from './isolation';
import type {Router} from 'express';
import type {OpenAPIV3_1} from 'openapi-types';
export interface EditionContext {deviceRepo:DeviceRepository;repo:JobRepository;occupied:()=>string[];dataDir:string;}
export interface EditionRuntime {
  policy:DevicePolicy;
  createScheduler:(deps:SchedulerDeps)=>SchedulerHandle;
  deviceRouting?: { enabled: () => boolean; routes: Router; openapiPaths?: OpenAPIV3_1.PathsObject };
  isolation?: IsolationHooks;
}
export type EditionFactory=(context:EditionContext)=>EditionRuntime;
export const communityRuntime:EditionFactory=ctx=>({
  policy:new CommunityPolicy(ctx.deviceRepo,ctx.repo,ctx.occupied),
  createScheduler:deps=>new SingleDeviceScheduler(deps),
});
