import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "../../src");

function allSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return allSourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

// Matches every static form that statically pulls an ESM-only package into
// the CommonJS build:
//   import x from "@yume-chan/..."     import type x from "@yume-chan/..."
//   import "@yume-chan/..."            (bare side-effect import, no `from`)
//   export { x } from "@yume-chan/..." export * from "@yume-chan/..."
const STATIC_YUME_CHAN_REFERENCE =
  /^\s*(?:import\b[^;]*from\s*["']@yume-chan\/|import\s*["']@yume-chan\/|export\b[^;]*from\s*["']@yume-chan\/)/m;

test("no source file statically imports an @yume-chan package", () => {
  // These packages are ESM-only and this backend is CommonJS. A static import
  // anywhere reachable from server.ts would break every Jest suite that builds
  // a server, and on farm-host would depend on require(esm), which is only
  // unflagged from Node 22.12.
  const offenders = allSourceFiles(SRC).filter((file) =>
    STATIC_YUME_CHAN_REFERENCE.test(fs.readFileSync(file, "utf8"))
  );
  expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
});

test("the ESM packages actually load from CommonJS under real Node", () => {
  // Jest cannot prove this - it is exactly what Jest cannot do. Spawn real
  // node, from a .cjs context, using the same escape hatch src/control/scrcpy.ts
  // uses.
  const script = `
    const importEsm = new Function("s", "return import(s)");
    Promise.all([
      importEsm("@yume-chan/adb"),
      importEsm("@yume-chan/adb-server-node-tcp"),
      importEsm("@yume-chan/adb-scrcpy"),
      importEsm("@yume-chan/stream-extra"),
    ]).then(([adb, tcp, scrcpy, streams]) => {
      const ok = typeof adb.AdbServerClient === "function"
        && typeof tcp.AdbServerNodeTcpConnector === "function"
        && typeof scrcpy.AdbScrcpyClient === "function"
        && typeof scrcpy.AdbScrcpyOptions3_3_2 === "function"
        && typeof streams.ReadableStream === "function";
      process.exit(ok ? 0 : 1);
    }).catch((e) => { console.error(e); process.exit(2); });
  `;
  expect(() =>
    execFileSync(process.execPath, ["-e", script], { cwd: path.join(__dirname, "../.."), stdio: "pipe" })
  ).not.toThrow();
});
