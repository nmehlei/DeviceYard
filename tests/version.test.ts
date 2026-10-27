import fs from "fs";
import { readBuildInfo } from "../src/version";

afterEach(() => jest.restoreAllMocks());

test("Pro reports its independent version and exact Community dependency", () => {
  jest.spyOn(fs, "readFileSync").mockReturnValue(`version=1.8.0\nedition=pro\ncoreVersion=1.5.0\ncore=${"a".repeat(40)}\npro=${"b".repeat(40)}\nsecret=never-return\n`);
  expect(readBuildInfo()).toEqual({ version: "1.8.0", edition: "pro", coreVersion: "1.5.0", revisions: { core: "a".repeat(40), pro: "b".repeat(40) } });
});

test("legacy bundles and missing metadata remain readable", () => {
  const read = jest.spyOn(fs, "readFileSync").mockReturnValue("version=9.9.9\ncommit=abc\n");
  expect(readBuildInfo()).toEqual({ version: "9.9.9" });
  read.mockImplementation(() => { throw Error("ENOENT"); });
  expect(readBuildInfo()).toEqual({ version: "unknown" });
});
