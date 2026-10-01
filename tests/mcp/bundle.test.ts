import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, spawn } from "child_process";

const REPO = path.join(__dirname, "..", "..");
// dist/src/, not dist/: adding shared/ to the compilation set tsconfig's
// rootDir to ".", so tsc now mirrors the source tree under dist/. The bundle
// has to sit beside the compiled server, because src/api/mcpClient.ts resolves
// it as path.join(__dirname, "mcp.mjs") and __dirname is dist/src at runtime.
const BUNDLE = path.join(REPO, "dist", "src", "mcp.mjs");

describe("dist/src/mcp.mjs", () => {
  beforeAll(() => {
    execFileSync("npm", ["run", "build:mcp"], { cwd: REPO, stdio: "pipe" });
  }, 120000);

  it("is a single self-contained file", () => {
    expect(fs.existsSync(BUNDLE)).toBe(true);
    expect(fs.statSync(BUNDLE).size).toBeGreaterThan(10000);
  });

  /** The whole distribution story is "curl one file and run it". If the
   * bundle needs node_modules next to it, that story is false, and the
   * first consumer is the one who finds out. */
  it("answers an MCP initialize with no node_modules present", async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-bundle-"));
    try {
      const copied = path.join(sandbox, "mcp.mjs");
      fs.copyFileSync(BUNDLE, copied);

      const child = spawn(process.execPath, [copied], {
        cwd: sandbox,
        env: { ...process.env, MOBILE_FARM_URL: "http://127.0.0.1:1", MOBILE_FARM_TOKEN: "t" },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const request = JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      });
      child.stdin.write(`${request}\n`);

      let response: string;
      try {
        response = await new Promise<string>((resolve, reject) => {
          let out = "";
          const timer = setTimeout(() => reject(new Error(`no response; stdout was: ${out}`)), 20000);
          child.stdout.on("data", (chunk) => {
            out += String(chunk);
            if (out.includes("\n")) { clearTimeout(timer); resolve(out); }
          });
          child.on("error", reject);
        });
      } finally {
        child.kill();
      }

      const parsed = JSON.parse(response.split("\n")[0]);
      expect(parsed.result.serverInfo.name).toBe("deviceyard");
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  }, 40000);
});
