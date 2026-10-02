import fs from "fs";
import os from "os";
import path from "path";
import { credentials, resolveConnection } from "../src/resolve";

const URL = "https://farm.example.com";

describe("resolveConnection", () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "dy-res-")); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it("prefers --api-key over the env var and the file", () => {
    credentials.saveCredential(URL, "from-file", home);
    const r = resolveConnection({ apiKey: "from-flag", url: URL }, { DEVICEYARD_API_KEY: "from-env" }, home);
    expect(r.token).toBe("from-flag");
    expect(r.kind).toBe("org");
  });

  it("falls back to DEVICEYARD_API_KEY", () => {
    expect(resolveConnection({ url: URL }, { DEVICEYARD_API_KEY: "from-env" }, home).token).toBe("from-env");
  });

  it("falls back to the stored personal credential", () => {
    credentials.saveCredential(URL, "from-file", home);
    expect(resolveConnection({ url: URL }, {}, home)).toMatchObject({ token: "from-file", kind: "personal" });
  });

  it("accepts the legacy MOBILE_FARM_* variables", () => {
    const r = resolveConnection({}, { MOBILE_FARM_URL: URL, MOBILE_FARM_TOKEN: "legacy" }, home);
    expect(r).toMatchObject({ farmUrl: URL, token: "legacy" });
  });

  it("prefers DEVICEYARD_URL over MOBILE_FARM_URL", () => {
    const r = resolveConnection({}, {
      DEVICEYARD_URL: "https://new.example.com",
      MOBILE_FARM_URL: "https://old.example.com",
      DEVICEYARD_API_KEY: "t",
    }, home);
    expect(r.farmUrl).toBe("https://new.example.com");
  });

  it("prefers --url over both env vars", () => {
    const r = resolveConnection(
      { url: "https://flag.example.com" },
      { DEVICEYARD_URL: "https://env.example.com", DEVICEYARD_API_KEY: "t" },
      home,
    );
    expect(r.farmUrl).toBe("https://flag.example.com");
  });

  it("strips a pasted ?token= from the farm URL", () => {
    const r = resolveConnection({ url: `${URL}/status?token=leaked` }, { DEVICEYARD_API_KEY: "t" }, home);
    expect(r.farmUrl).toBe(`${URL}/status`);
    expect(r.farmUrl).not.toContain("leaked");
  });

  it("carries the timeout, defaulting when unset", () => {
    expect(resolveConnection({ url: URL }, { DEVICEYARD_API_KEY: "t" }, home).timeoutMs).toBe(900000);
    expect(resolveConnection({ url: URL }, { DEVICEYARD_API_KEY: "t", DEVICEYARD_TIMEOUT_MS: "5000" }, home).timeoutMs).toBe(5000);
  });

  it("passes the org id through", () => {
    expect(resolveConnection({ url: URL, org: 7 }, { DEVICEYARD_API_KEY: "t" }, home).orgId).toBe(7);
  });

  it("tells a personal-credential user to name an org", () => {
    credentials.saveCredential(URL, "from-file", home);
    expect(() => resolveConnection({ url: URL }, {}, home, { requireOrg: true })).toThrow(/--org/);
  });

  it("does not demand an org for an org token", () => {
    expect(() => resolveConnection({ url: URL }, { DEVICEYARD_API_KEY: "t" }, home, { requireOrg: true })).not.toThrow();
  });

  it("says how to authenticate when there is no credential at all", () => {
    expect(() => resolveConnection({ url: URL }, {}, home)).toThrow(/deviceyard login/);
  });

  it("names --url when no farm URL is available anywhere", () => {
    expect(() => resolveConnection({}, {}, home)).toThrow(/--url/);
  });
});
