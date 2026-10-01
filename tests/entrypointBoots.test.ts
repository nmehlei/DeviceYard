import { execFileSync, spawn } from "child_process";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";

const repoRoot = path.join(__dirname, "..");

/** 0.1.50 shipped a dist/index.js that only `require`d the real entrypoint.
 * Because that made dist/index.js the main module, src/index.ts's
 * `require.main === module` guard never fired: the service loaded everything,
 * started nothing, and exited 0. systemd reported success. The farm served
 * 502 for a quarter of an hour.
 *
 * The check that let it through asserted the require did not throw, while a
 * setTimeout held the event loop open — so "still alive after 3s" proved
 * nothing at all. This test instead does the only thing that would have
 * caught it: run the shim exactly as systemd does, and make an HTTP request. */
describe("the packaged entrypoint actually serves traffic", () => {
  let dir: string;

  beforeAll(() => {
    execFileSync("npx", ["tsc"], { cwd: repoRoot, stdio: "pipe" });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dy-boot-"));
  }, 180000);

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("boots and answers a request when started via dist/index.js", async () => {
    // Byte-for-byte what ci/package.sh writes.
    const shim = path.join(repoRoot, "dist", "index.js");
    fs.writeFileSync(shim, 'require("./src/index.js").main();\n');

    const port = 18099 + (process.pid % 500);
    const child = spawn(process.execPath, [shim], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dir,
        DEVICE_ID: "test-device",
        TOKENS_JSON: JSON.stringify({ testorg: "t" }),
        TOKEN_ENCRYPTION_KEY: "0".repeat(64),
        SESSION_SECRET: "test-session-secret-long-enough-for-config",
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "test-admin-password",
        ADMIN_EMAIL: "admin@example.com",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let exitedEarly: number | null = null;
    child.on("exit", (code) => { exitedEarly = code; });

    try {
      const status = await new Promise<number>((resolve, reject) => {
        const deadline = Date.now() + 25000;
        const poll = () => {
          // An exit(0) is the exact failure being guarded against, and it must
          // fail loudly rather than look like "not ready yet".
          if (exitedEarly !== null) {
            reject(new Error(`the entrypoint exited with code ${exitedEarly} instead of listening`));
            return;
          }
          if (Date.now() > deadline) { reject(new Error("timed out waiting for the server")); return; }
          const req = http.get({ host: "127.0.0.1", port, path: "/login" }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.on("error", () => setTimeout(poll, 250));
        };
        poll();
      });

      // Any HTTP answer proves it is listening; the route itself is not the point.
      expect(status).toBeGreaterThan(0);
    } finally {
      child.kill("SIGKILL");
      fs.rmSync(shim, { force: true });
    }
  }, 60000);
});
