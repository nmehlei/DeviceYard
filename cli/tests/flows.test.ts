import path from "path";
import { findE2eRoot, resolveFlows } from "../src/flows";

const repo = path.join(__dirname, "fixtures", "repo");
const e2e = path.join(repo, "e2e");
const scenarios = path.join(e2e, "scenarios");

describe("findE2eRoot", () => {
  it("finds e2e/ when pointed at the scenarios directory", () => {
    expect(findE2eRoot(scenarios)).toBe(e2e);
  });

  it("finds it when pointed at a nested sub-directory", () => {
    expect(findE2eRoot(path.join(scenarios, "map"))).toBe(e2e);
  });

  it("finds it when pointed at a single flow file", () => {
    expect(findE2eRoot(path.join(scenarios, "login.yaml"))).toBe(e2e);
  });

  it("finds it when pointed at e2e/ itself", () => {
    expect(findE2eRoot(e2e)).toBe(e2e);
  });

  it("explains the expected layout when there is no e2e/scenarios ancestor", () => {
    expect(() => findE2eRoot(path.join(__dirname, "fixtures")))
      .toThrow(/expects an e2e\/scenarios directory/);
  });
});

describe("resolveFlows", () => {
  it("returns ids relative to e2e/scenarios, without the extension, sorted", () => {
    expect(resolveFlows(scenarios, []).flowIds).toEqual(["login", "map/filter", "untagged"]);
  });

  it("ignores .yml, because jobRunner only ever resolves .yaml", () => {
    expect(resolveFlows(scenarios, []).flowIds).not.toContain("map/zoom");
  });

  it("returns exactly one id when pointed at a single file", () => {
    expect(resolveFlows(path.join(scenarios, "login.yaml"), []).flowIds).toEqual(["login"]);
  });

  it("does not treat e2e/shared as flows when pointed at e2e/", () => {
    expect(resolveFlows(e2e, []).flowIds).toEqual(["login", "map/filter", "untagged"]);
  });

  it("reports the e2e root alongside the ids", () => {
    expect(resolveFlows(scenarios, []).e2eRoot).toBe(e2e);
  });

  it("honours --exclude-flows for both a file and a sub-directory", () => {
    expect(resolveFlows(scenarios, ["map"]).flowIds).toEqual(["login", "untagged"]);
    expect(resolveFlows(scenarios, ["login"]).flowIds).toEqual(["map/filter", "untagged"]);
  });

  it("accepts an excluded flow written with its .yaml extension", () => {
    expect(resolveFlows(scenarios, ["login.yaml"]).flowIds).toEqual(["map/filter", "untagged"]);
  });

  it("fails rather than submitting an empty flow list", () => {
    // POST /run rejects an empty array with 400; failing here says why.
    expect(() => resolveFlows(scenarios, ["login", "map", "untagged"]))
      .toThrow(/no flows left to run/);
  });

  it("reports a path that does not exist", () => {
    expect(() => resolveFlows(path.join(scenarios, "nope.yaml"), [])).toThrow(/no such path/);
  });
});
