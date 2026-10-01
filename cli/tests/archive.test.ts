import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { buildFlowsArchive } from "../src/archive";

const e2e = path.join(__dirname, "fixtures", "repo", "e2e");

describe("buildFlowsArchive", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dy-arch-")); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it("produces an archive rooted at e2e/, matching what extractArchive expects", async () => {
    const out = path.join(tmp, "e2e.tar.gz");
    await buildFlowsArchive(e2e, out);

    const listing = execFileSync("tar", ["-tzf", out], { encoding: "utf8" }).split("\n");
    expect(listing).toEqual(expect.arrayContaining([
      expect.stringMatching(/^e2e\/scenarios\/login\.yaml$/),
      expect.stringMatching(/^e2e\/scenarios\/map\/filter\.yaml$/),
      // shared/ must be included: relative references between flows depend on it.
      expect.stringMatching(/^e2e\/shared\/helpers\.yaml$/),
    ]));
  });

  it("round-trips through the same tar the server extracts with", async () => {
    const out = path.join(tmp, "e2e.tar.gz");
    await buildFlowsArchive(e2e, out);
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "dy-ext-"));
    try {
      execFileSync("tar", ["-xzf", out, "-C", dest]);
      // The exact path src/jobRunner.ts resolves.
      expect(fs.existsSync(path.join(dest, "e2e", "scenarios", "map", "filter.yaml"))).toBe(true);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  it("fails with a readable message when tar is not available", async () => {
    await expect(buildFlowsArchive(e2e, path.join(tmp, "x.tar.gz"), "definitely-not-tar"))
      .rejects.toThrow(/could not run "definitely-not-tar"/);
  });

  it("reports tar's own stderr when it fails for another reason", async () => {
    await expect(buildFlowsArchive("/nonexistent/e2e", path.join(tmp, "x.tar.gz")))
      .rejects.toThrow(/failed to build the flows archive/);
  });
});
