import path from "path";
import { readFlowTags, filterByTags, resolveFlows } from "../src/flows";

const e2e = path.join(__dirname, "fixtures", "repo", "e2e");
const all = resolveFlows(path.join(e2e, "scenarios"), []);

describe("readFlowTags", () => {
  it("reads a block-sequence tags list", () => {
    expect(readFlowTags(e2e, "login")).toEqual(["smoke"]);
  });

  it("reads a flow-sequence tags list", () => {
    expect(readFlowTags(e2e, "map/filter")).toEqual(["slow", "regression"]);
  });

  it("returns [] for a flow with no tags", () => {
    expect(readFlowTags(e2e, "untagged")).toEqual([]);
  });

  it("returns [] for a flow that does not exist", () => {
    expect(readFlowTags(e2e, "nope")).toEqual([]);
  });

  it("only reads the header, never the steps below ---", () => {
    // map/filter.yaml has a step containing the literal text "tags:".
    expect(readFlowTags(e2e, "map/filter")).toEqual(["slow", "regression"]);
  });
});

describe("filterByTags", () => {
  it("keeps only flows carrying an included tag", () => {
    expect(filterByTags(all, ["smoke"], []).flowIds).toEqual(["login"]);
  });

  it("drops flows carrying an excluded tag", () => {
    expect(filterByTags(all, [], ["slow"]).flowIds).toEqual(["login", "untagged"]);
  });

  it("applies exclude after include", () => {
    expect(() => filterByTags(all, ["smoke"], ["smoke"])).toThrow(/no flows match/);
  });

  it("is a no-op when neither list is given", () => {
    expect(filterByTags(all, [], []).flowIds).toEqual(all.flowIds);
  });

  it("keeps the e2e root unchanged", () => {
    expect(filterByTags(all, ["smoke"], []).e2eRoot).toBe(all.e2eRoot);
  });

  it("points at --dry-run when nothing matches", () => {
    expect(() => filterByTags(all, ["nonexistent"], [])).toThrow(/--dry-run/);
  });
});
