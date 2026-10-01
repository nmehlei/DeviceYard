import fs from "fs";
import os from "os";
import path from "path";
import { createCredentialStore } from "../../shared/credentials";

const mk = (dirName: string, tokenEnvVar: string) =>
  createCredentialStore({ dirName, tokenEnvVar, missingHint: "hint" });

const URL = "https://f.example.com";

describe("createCredentialStore", () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "cred-")); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it("keeps two stores in separate directories", () => {
    const farm = mk(".mobile-farm", "MOBILE_FARM_TOKEN");
    const yard = mk(".deviceyard", "DEVICEYARD_API_KEY");

    farm.saveCredential(URL, "token-a", home);
    yard.saveCredential(URL, "token-b", home);

    expect(farm.loadCredential(URL, {}, home).token).toBe("token-a");
    expect(yard.loadCredential(URL, {}, home).token).toBe("token-b");
  });

  it("reads its own env var and ignores the other store's", () => {
    const yard = mk(".deviceyard", "DEVICEYARD_API_KEY");
    const cred = yard.loadCredential(URL, { MOBILE_FARM_TOKEN: "wrong", DEVICEYARD_API_KEY: "right" }, home);
    expect(cred).toEqual({ token: "right", kind: "org" });
  });

  it("falls back to a second env var when configured", () => {
    const yard = createCredentialStore({
      dirName: ".deviceyard",
      tokenEnvVar: "DEVICEYARD_API_KEY",
      fallbackTokenEnvVar: "MOBILE_FARM_TOKEN",
      missingHint: "hint",
    });
    expect(yard.loadCredential(URL, { MOBILE_FARM_TOKEN: "legacy" }, home).token).toBe("legacy");
  });

  it("prefers its own env var over the fallback", () => {
    const yard = createCredentialStore({
      dirName: ".deviceyard",
      tokenEnvVar: "DEVICEYARD_API_KEY",
      fallbackTokenEnvVar: "MOBILE_FARM_TOKEN",
      missingHint: "hint",
    });
    const env = { DEVICEYARD_API_KEY: "new", MOBILE_FARM_TOKEN: "legacy" };
    expect(yard.loadCredential(URL, env, home).token).toBe("new");
  });

  it("still refuses a group- or world-readable credential file", () => {
    const yard = mk(".deviceyard", "DEVICEYARD_API_KEY");
    yard.saveCredential(URL, "t", home);
    fs.chmodSync(path.join(home, ".deviceyard", "credentials"), 0o644);
    expect(() => yard.loadCredential(URL, {}, home)).toThrow(/readable by other users/);
  });

  it("keeps the file 0600 across an overwrite, not just on creation", () => {
    // writeFileSync({ mode }) only applies the mode on O_CREAT, so a
    // chmod-after-write pattern would leave a world-readable window here.
    const yard = mk(".deviceyard", "DEVICEYARD_API_KEY");
    yard.saveCredential(URL, "first", home);
    yard.saveCredential(URL, "second", home);
    const file = path.join(home, ".deviceyard", "credentials");
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(yard.loadCredential(URL, {}, home).token).toBe("second");
  });

  it("normalises the farm URL so it keys identically however it was typed", () => {
    const yard = mk(".deviceyard", "DEVICEYARD_API_KEY");
    yard.saveCredential(`${URL}/`, "t", home);
    expect(yard.loadCredential(`${URL}?token=leaked`, {}, home).token).toBe("t");
  });

  it("puts the caller's hint in the missing-credential error", () => {
    const yard = createCredentialStore({
      dirName: ".deviceyard", tokenEnvVar: "DEVICEYARD_API_KEY",
      missingHint: "Run `deviceyard login`.",
    });
    expect(() => yard.loadCredential(URL, {}, home)).toThrow(/Run `deviceyard login`\./);
  });
});
