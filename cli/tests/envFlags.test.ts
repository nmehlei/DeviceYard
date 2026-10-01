import { parseEnvPairs } from "../src/envFlags";

describe("parseEnvPairs", () => {
  it("returns undefined for no pairs, so the request omits the field entirely", () => {
    // Absent is NOT {}: an absent env field must produce a byte-identical
    // argument list to before the feature existed. See src/env.ts.
    expect(parseEnvPairs([])).toBeUndefined();
  });

  it("splits on the first = only, so values may contain =", () => {
    expect(parseEnvPairs(["URL=https://x/?a=b"])).toEqual({ URL: "https://x/?a=b" });
  });

  it("accepts an empty value", () => {
    expect(parseEnvPairs(["EMPTY="])).toEqual({ EMPTY: "" });
  });

  it("rejects a pair with no =", () => {
    expect(() => parseEnvPairs(["JUSTAKEY"])).toThrow(/--env "JUSTAKEY" must be KEY=VALUE/);
  });

  it("rejects a pair that starts with =", () => {
    expect(() => parseEnvPairs(["=novalue"])).toThrow(/must be KEY=VALUE/);
  });

  it("applies the server's key rules before any upload happens", () => {
    expect(() => parseEnvPairs(["9BAD=x"])).toThrow(/is not a valid identifier/);
  });

  it("applies the server's secret-length rule", () => {
    expect(() => parseEnvPairs(["API_TOKEN=ab"])).toThrow(/too short to mask safely/);
  });

  it("rejects a newline in a value", () => {
    expect(() => parseEnvPairs(["A=one\ntwo"])).toThrow(/must not contain a newline or NUL/);
  });

  it("lets a later pair win over an earlier one with the same key", () => {
    expect(parseEnvPairs(["A=1", "A=2"])).toEqual({ A: "2" });
  });
});
