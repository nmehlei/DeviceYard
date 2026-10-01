import fs from "fs";
import os from "os";
import path from "path";
import { loadCredential, saveCredential, credentialsPath } from "../../src/mcp/credentials";

const URL = "https://farm.example";
let home: string;

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "pat-cred-")); });
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("loadCredential", () => {
  it("prefers MOBILE_FARM_TOKEN and reports it as an org token", () => {
    saveCredential(URL, "pat-token", home);
    expect(loadCredential(URL, { MOBILE_FARM_TOKEN: "org-token" }, home))
      .toEqual({ token: "org-token", kind: "org" });
  });

  it("falls back to the credentials file as a personal token", () => {
    saveCredential(URL, "pat-token", home);
    expect(loadCredential(URL, {}, home)).toEqual({ token: "pat-token", kind: "personal" });
  });

  it("matches the farm url ignoring a trailing slash", () => {
    saveCredential("https://farm.example/", "pat-token", home);
    expect(loadCredential(URL, {}, home).token).toBe("pat-token");
  });

  it("explains what to do when there is no credential at all", () => {
    expect(() => loadCredential(URL, {}, home)).toThrow(/--save-credential|MOBILE_FARM_TOKEN/);
  });

  it("refuses a credentials file other users can read", () => {
    saveCredential(URL, "pat-token", home);
    fs.chmodSync(credentialsPath(home), 0o644);
    expect(() => loadCredential(URL, {}, home)).toThrow(/permission|0600/i);
  });

  it("never puts the token in an error message", () => {
    saveCredential(URL, "pat-token", home);
    fs.chmodSync(credentialsPath(home), 0o644);
    try {
      loadCredential(URL, {}, home);
      throw new Error("expected a throw");
    } catch (err) {
      expect(String(err)).not.toContain("pat-token");
    }
  });
});

describe("saveCredential", () => {
  it("writes 0600 and keeps other farms' entries", () => {
    saveCredential(URL, "one", home);
    saveCredential("https://other.example", "two", home);
    expect(fs.statSync(credentialsPath(home)).mode & 0o777).toBe(0o600);
    expect(loadCredential(URL, {}, home).token).toBe("one");
    expect(loadCredential("https://other.example", {}, home).token).toBe("two");
  });

  it("enforces 0600 even when overwriting a loose credentials file", () => {
    // Create a credentials file with two farms
    saveCredential(URL, "farm1-token", home);
    saveCredential("https://other.example", "farm2-token", home);

    // Simulate a loose file (chmod to world-readable, as might happen with
    // older tooling, external editing, or an attacker priming the file)
    fs.chmodSync(credentialsPath(home), 0o644);

    // Re-save to the first farm with a new token
    saveCredential(URL, "farm1-new-token", home);

    // Verify mode is enforced even on overwrite: file must be 0600
    expect(fs.statSync(credentialsPath(home)).mode & 0o777).toBe(0o600);

    // Verify both tokens are still accessible and other farms' entries survived
    expect(loadCredential(URL, {}, home).token).toBe("farm1-new-token");
    expect(loadCredential("https://other.example", {}, home).token).toBe("farm2-token");
  });
});
