import { createProgress } from "../src/output";
import type { Io } from "../src/main";

function makeIo() {
  const lines: string[] = [];
  const i: Io = { out: (s) => lines.push(s), err: () => {}, env: {} };
  return { i, lines };
}

describe("Progress.status", () => {
  it("announces once when the job is queued", () => {
    const { i, lines } = makeIo();
    let now = 0;
    const progress = createProgress(i, false, () => now);
    progress.status("queued");
    expect(lines).toHaveLength(1);
    expect(lines[0].toLowerCase()).toContain("queued");
  });

  it("does not repeat on every poll while nothing has changed and no heartbeat is due", () => {
    const { i, lines } = makeIo();
    let now = 0;
    const progress = createProgress(i, false, () => now);
    progress.status("queued");
    now += 5_000;
    progress.status("queued");
    now += 5_000;
    progress.status("queued");
    expect(lines).toHaveLength(1);
  });

  it("prints a heartbeat while still queued after a long wait, so a stuck queue looks different from a hang", () => {
    // Build 2395: a job queued 2h41m behind another job looked identical, in
    // the log, to the CLI having hung.
    const { i, lines } = makeIo();
    let now = 0;
    const progress = createProgress(i, false, () => now);
    progress.status("queued");
    now += 61_000;
    progress.status("queued");
    now += 61_000;
    progress.status("queued");
    expect(lines).toHaveLength(3);
  });

  it("announces the transition from queued to running", () => {
    const { i, lines } = makeIo();
    let now = 0;
    const progress = createProgress(i, false, () => now);
    progress.status("queued");
    progress.status("running");
    expect(lines).toHaveLength(2);
    expect(lines[1].toLowerCase()).toContain("running");
  });

  it("says nothing for a terminal status - summarise() already reports the verdict", () => {
    const { i, lines } = makeIo();
    const progress = createProgress(i, false, () => 0);
    progress.status("done");
    progress.status("failed");
    expect(lines).toHaveLength(0);
  });

  it("is silent under --quiet, like step()", () => {
    const { i, lines } = makeIo();
    let now = 0;
    const progress = createProgress(i, true, () => now);
    progress.status("queued");
    now += 120_000;
    progress.status("queued");
    expect(lines).toHaveLength(0);
  });
});
