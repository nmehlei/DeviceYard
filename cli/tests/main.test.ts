import { run, type Io } from "../src/main";
import { EXIT_OK, EXIT_ERROR } from "../src/exit";

function io(env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const i: Io = { out: (s) => out.push(s), err: (s) => err.push(s), env };
  return { io: i, out, err };
}

describe("run", () => {
  it("prints usage and exits 0 for --help", async () => {
    const { io: i, out } = io();
    expect(await run(["--help"], i)).toBe(EXIT_OK);
    expect(out.join("\n")).toContain("deviceyard cloud <app-file> <flows-dir>");
  });

  it("--help describes the isolation cost", async () => {
    const { io: i, out } = io();
    expect(await run(["cloud", "--help"], i)).toBe(EXIT_OK);
    const text = out.join("\n");
    expect(text).toContain("--isolation");
    expect(text).toContain("about 15-40 s and about 1.5 GB of device writes per job");
    expect(text).toContain("a 27-flow suite writes about 40 GB");
  });

  it("prints the local version for --version", async () => {
    const { io: i, out } = io();
    expect(await run(["--version"], i)).toBe(EXIT_OK);
    expect(out.join("\n")).toMatch(/^(\d+\.\d+\.\d+|unknown)/);
  });

  it("exits 1 with a did-you-mean on an unknown command", async () => {
    const { io: i, err } = io();
    expect(await run(["clod"], i)).toBe(EXIT_ERROR);
    expect(err.join("\n")).toContain('unknown command "clod"');
    expect(err.join("\n")).toContain('did you mean "cloud"');
  });

  it("exits 1 with usage when given no command at all", async () => {
    const { io: i, err } = io();
    expect(await run([], i)).toBe(EXIT_ERROR);
    expect(err.join("\n")).toContain("deviceyard cloud <app-file> <flows-dir>");
  });

  it("does not suggest a command that is nothing like the input", async () => {
    const { io: i, err } = io();
    await run(["xyzzy"], i);
    expect(err.join("\n")).not.toContain("did you mean");
  });

  it("whoami accepts --url, like login does", async () => {
    // It used to ignore rest entirely and then complain that --url was
    // missing while the user was passing it. Reaching resolveConnection with
    // the flag parsed is what matters; the farm is unreachable in a test, so
    // any error must NOT be the "is required" one.
    const { io: i, err } = io();
    await run(["whoami", "--url", "https://farm.invalid"], i);
    expect(err.join("\n")).not.toMatch(/DEVICEYARD_URL is required/);
  });

  it("still explains when no farm URL is given at all", async () => {
    const { io: i, err } = io();
    expect(await run(["whoami"], i)).toBe(EXIT_ERROR);
    expect(err.join("\n")).toMatch(/--url/);
  });
});
