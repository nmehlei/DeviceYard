import { findForbiddenImports } from "./boundaryScanner";

describe("findForbiddenImports", () => {
  it.each([
    ['import "express";', "express"],
    ['const x = require("../server");', "../server"],
    ['await import("../store/jobRepository");', "../store/jobRepository"],
    ['import { JobRepository } from "../store/jobRepository";', "../store/jobRepository"],
  ])("flags %s", (source, expected) => {
    expect(findForbiddenImports(source)).toContain(expected);
  });

  it.each(["./config", "../client", "fs", "path", "@modelcontextprotocol/sdk/server/mcp.js", "zod"])(
    "does not flag legitimate specifier %s",
    (spec) => {
      const source = `import x from "${spec}";\nrequire("${spec}");\nimport("${spec}");`;
      expect(findForbiddenImports(source)).toEqual([]);
    },
  );
});
