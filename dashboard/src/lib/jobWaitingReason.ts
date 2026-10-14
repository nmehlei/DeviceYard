const reasons: Record<string, string> = {
  PRO_ROUTING_REQUIRED: 'Waiting for an active Pro license to use the required device tags.',
  NO_MATCHING_DEVICE: 'No enrolled device has all the required tags.',
  MATCHING_DEVICES_UNAVAILABLE: 'Matching devices are offline or unavailable. The job will resume when one recovers.',
  MATCHING_DEVICES_BUSY: 'Waiting for a matching device to become free.',
  CHECKING_MATCHING_DEVICES: 'Checking matching device availability.',
  MAINTENANCE: 'Waiting for maintenance to end.',
  CONCURRENCY_LIMIT: 'Waiting for a running job to finish or the concurrency limit to increase.',
};
export function jobWaitingReason(code?: string | null): string | undefined {
  return code ? reasons[code] ?? 'Waiting for a suitable device.' : undefined;
}
