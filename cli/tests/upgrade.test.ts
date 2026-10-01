import fs from "fs";
import os from "os";
import path from "path";
import { runUpgrade } from "../src/commands/upgrade";
import { EXIT_ERROR } from "../src/exit";
import type { Io } from "../src/main";

function io(env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const i: Io = { out: (s) => out.push(s), err: (s) => err.push(s), env };
  return { io: i, out, err };
}

describe("runUpgrade", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "dy-up-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const fakeBinary = (base: string): string => {
    const p = path.join(base, "bin", "deviceyard");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "#!/bin/sh\n");
    return p;
  };

  it("refuses to self-upgrade an npm install and points at npm", () => {
    const nm = path.join(dir, "node_modules", "@deviceyard", "cli-linux-x64");
    const { io: i, err } = io({ DEVICEYARD_URL: "https://f.example" });
    // Must not shell out at all - it returns before reaching curl.
    expect(runUpgrade(i, fakeBinary(nm))).toBe(EXIT_ERROR);
    expect(err.join("\n")).toContain("npm install -g @deviceyard/cli@latest");
  });

  it("needs a farm URL and says which variable to set", () => {
    const { io: i, err } = io();
    expect(runUpgrade(i, fakeBinary(dir))).toBe(EXIT_ERROR);
    expect(err.join("\n")).toContain("DEVICEYARD_URL");
  });

  it("reports a binary path that does not exist rather than throwing raw", () => {
    const { io: i, err } = io({ DEVICEYARD_URL: "https://f.example" });
    expect(runUpgrade(i, path.join(dir, "nope"))).toBe(EXIT_ERROR);
    expect(err.join("\n")).not.toBe("");
  });
});
