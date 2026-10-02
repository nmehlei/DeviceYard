import { createCredentialStore, type Credential } from "../../shared/credentials";

export type { Credential };

const store = createCredentialStore({
  dirName: ".mobile-farm",
  tokenEnvVar: "MOBILE_FARM_TOKEN",
  missingHint:
    "Create a personal access token in the dashboard, " +
    "then run: mcp.mjs --save-credential (it reads the token from stdin). " +
    "Alternatively set MOBILE_FARM_TOKEN to an org token.",
});

export const credentialsPath = store.credentialsPath;
export const loadCredential = store.loadCredential;
export const saveCredential = store.saveCredential;
