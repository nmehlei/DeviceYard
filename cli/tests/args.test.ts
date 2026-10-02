import { parseCloud, UNSUPPORTED } from "../src/args";
import { CliError } from "../src/exit";

describe("parseCloud - tier 1, implemented", () => {
  it("takes the app and flows positionally", () => {
    const o = parseCloud(["app.apk", "e2e/scenarios"]);
    expect(o.appFilePositional).toBe("app.apk");
    expect(o.flowsPath).toBe("e2e/scenarios");
  });

  it("accepts --app-file and --flows instead of positionals", () => {
    const o = parseCloud(["--app-file", "a.apk", "--flows", "e2e/scenarios"]);
    expect(o.appFile).toBe("a.apk");
    expect(o.flowsPath).toBe("e2e/scenarios");
  });

  it("collects a repeated --env", () => {
    const o = parseCloud(["app.apk", "flows/", "--env", "A=1", "--env", "B=2"]);
    expect(o.envPairs).toEqual(["A=1", "B=2"]);
  });

  it("splits comma-separated tag lists", () => {
    const o = parseCloud(["app.apk", "flows/", "--include-tags", "smoke,critical", "--exclude-tags", "slow"]);
    expect(o.includeTags).toEqual(["smoke", "critical"]);
    expect(o.excludeTags).toEqual(["slow"]);
  });

  it("defaults artifactsPath to ./artifacts, and reports it as a directory", () => {
    expect(parseCloud(["app.apk", "flows/"]).artifactsPath).toBe("./artifacts");
  });

  it("accepts --report junit and rejects other report formats by name", () => {
    expect(parseCloud(["a.apk", "f/", "--report", "junit"]).report).toBe("junit");
    expect(() => parseCloud(["a.apk", "f/", "--report", "allure"]))
      .toThrow(/only --report junit is supported/);
  });

  it("requires --json-file when --json-file-name is given", () => {
    expect(() => parseCloud(["a.apk", "f/", "--json-file-name", "r.json"]))
      .toThrow(/--json-file-name requires --json-file/);
  });

  it("requires --download-artifacts when --artifacts-path is given", () => {
    expect(() => parseCloud(["a.apk", "f/", "--artifacts-path", "./x"]))
      .toThrow(/--artifacts-path requires --download-artifacts/);
  });

  it("rejects a --org that is not a positive integer", () => {
    expect(() => parseCloud(["a.apk", "f/", "--org", "abc"])).toThrow(/--org must be a positive integer/);
    expect(() => parseCloud(["a.apk", "f/", "--org", "0"])).toThrow(/--org must be a positive integer/);
  });

  it("reports a flag given without its value", () => {
    expect(() => parseCloud(["a.apk", "f/", "--env"])).toThrow(/--env requires a value/);
  });

  it("requires both an app file and a flows path", () => {
    expect(() => parseCloud([])).toThrow(/an app file is required/);
    expect(() => parseCloud(["a.apk"])).toThrow(/a flows path is required/);
  });

  it("uppercases --download-artifacts and rejects anything else", () => {
    expect(parseCloud(["a.apk", "f/", "--download-artifacts", "failed"]).downloadArtifacts).toBe("FAILED");
    expect(() => parseCloud(["a.apk", "f/", "--download-artifacts", "some"]))
      .toThrow(/--download-artifacts takes ALL or FAILED/);
  });
});

describe("parseCloud - tier 2, recognised and rejected with a reason", () => {
  it.each(Object.keys(UNSUPPORTED))("explains why %s is unsupported", (flag) => {
    let thrown: Error | undefined;
    try {
      parseCloud(["a.apk", "f/", flag, "x"]);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect(thrown!.message).not.toContain("unknown option");
    expect(thrown!.message).toContain(flag);
    // Every entry carries a real sentence, not a stub.
    expect(thrown!.message.length).toBeGreaterThan(flag.length + 25);
  });

  it("names the maestro-cloud flags a migrating pipeline is most likely to carry", () => {
    expect(() => parseCloud(["a.apk", "f/", "--ios-device", "iphone-16"]))
      .toThrow(/this farm runs one configured Android device/);
    expect(() => parseCloud(["a.apk", "f/", "--retry", "2"]))
      .toThrow(/retries are not supported/);
  });

  it("prefers the tier-2 reason over a did-you-mean", () => {
    // --android-device is 2 edits from nothing we support, but it must never
    // fall through to tier 3 and suggest an unrelated flag.
    expect(() => parseCloud(["a.apk", "f/", "--android-device", "pixel-7"]))
      .toThrow(/is not supported by this farm/);
  });
});

describe("parseCloud - tier 3, genuinely unknown", () => {
  it("reports an unknown option with a did-you-mean", () => {
    expect(() => parseCloud(["a.apk", "f/", "--includ-tags", "smoke"]))
      .toThrow(/unknown option "--includ-tags".*did you mean "--include-tags"/s);
  });

  it("omits the suggestion when nothing is close", () => {
    expect(() => parseCloud(["a.apk", "f/", "--wildly-different"])).toThrow(/unknown option/);
    expect(() => parseCloud(["a.apk", "f/", "--wildly-different"])).not.toThrow(/did you mean/);
  });
});
