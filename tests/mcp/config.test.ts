import { loadMcpConfig, safeUrl, redactToken } from "../../src/mcp/config";

const base = { MOBILE_FARM_URL: "https://farm.example" };

describe("loadMcpConfig", () => {
  it("reads the url and defaults the timeout to 15 minutes", () => {
    expect(loadMcpConfig(base)).toEqual({
      farmUrl: "https://farm.example",
      timeoutMs: 900000,
    });
  });

  it("strips a trailing slash so path joining never double-slashes", () => {
    expect(loadMcpConfig({ ...base, MOBILE_FARM_URL: "https://farm.example/" }).farmUrl)
      .toBe("https://farm.example");
  });

  it("drops a query string from the url, where a pasted ?token= would live", () => {
    // The exact paste mistake loadMcpConfig's error path already guards
    // against: the raw string would otherwise be concatenated into every
    // request URL and into get_artifact's human-facing link, neither of
    // which goes through safeUrl.
    const config = loadMcpConfig({ ...base, MOBILE_FARM_URL: "https://farm.example/?token=s3cret" });
    expect(config.farmUrl).toBe("https://farm.example");
    expect(config.farmUrl).not.toContain("s3cret");
  });

  it("drops a fragment and keeps a real base path", () => {
    expect(loadMcpConfig({ ...base, MOBILE_FARM_URL: "https://farm.example/farm/#x" }).farmUrl)
      .toBe("https://farm.example/farm");
  });

  it("accepts an explicit timeout", () => {
    expect(loadMcpConfig({ ...base, MOBILE_FARM_TIMEOUT_MS: "5000" }).timeoutMs).toBe(5000);
  });

  it("rejects a non-numeric or non-positive timeout rather than silently defaulting", () => {
    expect(() => loadMcpConfig({ ...base, MOBILE_FARM_TIMEOUT_MS: "soon" })).toThrow(/MOBILE_FARM_TIMEOUT_MS/);
    expect(() => loadMcpConfig({ ...base, MOBILE_FARM_TIMEOUT_MS: "0" })).toThrow(/MOBILE_FARM_TIMEOUT_MS/);
  });

  it("names the missing variable when the url is absent", () => {
    expect(() => loadMcpConfig({})).toThrow(/MOBILE_FARM_URL/);
    expect(() => loadMcpConfig({ MOBILE_FARM_TOKEN: "t" })).toThrow(/MOBILE_FARM_URL/);
  });

  // R10: a personal-access-token user has no MOBILE_FARM_TOKEN at all - it
  // lives in ~/.mobile-farm/credentials, read separately by loadCredential.
  // loadMcpConfig throwing here would report the opposite of the truth.
  it("does not require MOBILE_FARM_TOKEN - the token is resolved separately by loadCredential", () => {
    expect(() => loadMcpConfig({ MOBILE_FARM_URL: "https://farm.example" })).not.toThrow();
    expect(loadMcpConfig({ MOBILE_FARM_URL: "https://farm.example" })).toEqual({
      farmUrl: "https://farm.example",
      timeoutMs: 900000,
    });
  });

  it("rejects a non-http url", () => {
    expect(() => loadMcpConfig({ ...base, MOBILE_FARM_URL: "ftp://farm.example" })).toThrow(/MOBILE_FARM_URL/);
  });

  it("never puts the token in the error message when the url is bad", () => {
    try {
      loadMcpConfig({ MOBILE_FARM_URL: "nonsense", MOBILE_FARM_TOKEN: "s3cret" });
      throw new Error("expected loadMcpConfig to throw");
    } catch (err) {
      expect(String(err)).not.toContain("s3cret");
    }
  });
});

describe("safeUrl", () => {
  it("drops the query string, where ?token= lives", () => {
    expect(safeUrl("https://farm.example/api/jobs?token=s3cret&limit=5"))
      .toBe("https://farm.example/api/jobs");
  });

  it("leaves a query-less url alone", () => {
    expect(safeUrl("https://farm.example/api/jobs")).toBe("https://farm.example/api/jobs");
  });

  it("returns something harmless for an unparseable url", () => {
    expect(safeUrl("::::")).toBe("<unparseable url>");
  });
});

describe("redactToken", () => {
  it("replaces every occurrence of the token", () => {
    expect(redactToken("Bearer s3cret failed for s3cret", "s3cret"))
      .toBe("Bearer <redacted> failed for <redacted>");
  });

  it("is a no-op for an empty token rather than replacing everything", () => {
    expect(redactToken("hello", "")).toBe("hello");
  });
});
