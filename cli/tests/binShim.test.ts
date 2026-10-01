// The shim is plain CommonJS that ships in the published tarball and runs
// before anything of ours is compiled, so it is required rather than imported.
const { resolveBinary, SUPPORTED } = require("../bin/resolve");

describe("resolveBinary", () => {
  it("maps a platform+arch pair to its package name", () => {
    expect(resolveBinary("darwin", "arm64", () => "/p/deviceyard")).toEqual({
      pkg: "@deviceyard/cli-darwin-arm64",
      binary: "/p/deviceyard",
    });
    expect(resolveBinary("linux", "x64", () => "/p/deviceyard").pkg).toBe("@deviceyard/cli-linux-x64");
  });

  it("covers exactly the four targets ci/package-cli.sh compiles", () => {
    expect(Object.keys(SUPPORTED).sort())
      .toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
  });

  it("names the missing optional dependency when npm skipped it", () => {
    expect(() => resolveBinary("linux", "arm64", () => { throw new Error("MODULE_NOT_FOUND"); }))
      .toThrow(/@deviceyard\/cli-linux-arm64[\s\S]*--include=optional/);
  });

  it("says so plainly on an unsupported platform", () => {
    expect(() => resolveBinary("win32", "x64", () => "x"))
      .toThrow(/win32-x64 is not supported[\s\S]*curl/);
  });
});
