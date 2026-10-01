import { loadFarmConfig, type FarmEnvConfig, type FarmClientConfig } from "../../shared/config";

export { DEFAULT_TIMEOUT_MS, safeUrl, redactToken, normaliseFarmUrl } from "../../shared/config";

export type McpEnvConfig = FarmEnvConfig;
export type McpConfig = FarmClientConfig;

/** Deliberately does NOT require MOBILE_FARM_TOKEN: a personal-access-token
 * user has no such env var - their credential lives in
 * ~/.mobile-farm/credentials - and throwing here before loadCredential ever
 * runs would report exactly the opposite of the truth. The token is
 * resolved separately by loadCredential(farmUrl, env). */
export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpEnvConfig {
  return loadFarmConfig(env, {
    urlVar: "MOBILE_FARM_URL",
    timeoutVar: "MOBILE_FARM_TIMEOUT_MS",
  });
}
