import fs from "fs";
import path from "path";
import { UNSUPPORTED, KNOWN_OPTIONS } from "../src/args";
import { KNOWN_COMMANDS } from "../src/main";

const guide = fs.readFileSync(
  path.join(__dirname, "..", "..", "docs", "guide", "cli.md"),
  "utf8",
);

/** The migration table is the adoption artifact and the whole reason tier-2
 * rejections exist. A flag that is rejected in code but missing from the doc -
 * or listed in the doc and no longer rejected - makes the table a liar, and
 * nobody re-reads a table they have stopped trusting. */
describe("docs/guide/cli.md stays in sync with the CLI", () => {
  it.each(Object.keys(UNSUPPORTED))("documents the rejected flag %s", (flag) => {
    expect(guide).toContain(`\`${flag}\``);
  });

  it("documents every command", () => {
    for (const command of KNOWN_COMMANDS) {
      expect(guide).toContain(command);
    }
  });

  it("documents every implemented option", () => {
    const undocumented = KNOWN_OPTIONS
      .filter((o) => o !== "--help")
      .filter((o) => !guide.includes(`\`${o}`));
    expect(undocumented).toEqual([]);
  });

  it("lists no flag as rejected that the parser actually accepts", () => {
    for (const flag of Object.keys(UNSUPPORTED)) {
      expect(KNOWN_OPTIONS).not.toContain(flag);
    }
  });

  it("states all three exit codes", () => {
    for (const code of ["`0`", "`1`", "`2`"]) expect(guide).toContain(code);
  });
});
