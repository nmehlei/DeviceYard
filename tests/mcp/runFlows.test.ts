// tests/mcp/runFlows.test.ts
import fs from "fs";
import os from "os";
import path from "path";
import { runFlows } from "../../src/mcp/tools/runFlows";
import type { FarmClient } from "../../src/mcp/client";

function fakeClient(over: Partial<FarmClient> = {}): FarmClient {
  return {
    getJson: async () => ({}) as never,
    getBinary: async () => ({ bytes: Buffer.alloc(0), contentType: "", totalBytes: 0, partial: false }),
    postForm: async () => ({ id: "job-9", status: "queued" }),
    openEvents: async () => undefined,
    ...over,
  };
}

let dir: string;
let apk: string;
let e2e: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-run-"));
  apk = path.join(dir, "app.apk");
  fs.writeFileSync(apk, "apk-bytes");
  e2e = path.join(dir, "e2e");
  fs.mkdirSync(path.join(e2e, "scenarios"), { recursive: true });
  fs.writeFileSync(path.join(e2e, "scenarios", "map.yaml"), "appId: x\n");
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("run_flows argument validation", () => {
  it("rejects neither e2eDir nor flowsArchive", async () => {
    const result = await runFlows(fakeClient(), { apkPath: apk, flows: ["map"] });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/exactly one/);
  });

  it("rejects both, rather than silently preferring one", async () => {
    const result = await runFlows(fakeClient(), {
      apkPath: apk, flows: ["map"], e2eDir: e2e, flowsArchive: apk,
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/exactly one/);
  });

  it("rejects an empty flows array", async () => {
    const result = await runFlows(fakeClient(), { apkPath: apk, flows: [], e2eDir: e2e });
    expect(result.isError).toBe(true);
  });

  it("reports a missing apk by path, before uploading anything", async () => {
    let called = false;
    const result = await runFlows(fakeClient({ postForm: async () => { called = true; return { id: "x", status: "queued" }; } }), {
      apkPath: path.join(dir, "nope.apk"), flows: ["map"], e2eDir: e2e,
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("nope.apk");
    expect(called).toBe(false);
  });

  it("reports a missing e2e directory", async () => {
    const result = await runFlows(fakeClient(), {
      apkPath: apk, flows: ["map"], e2eDir: path.join(dir, "absent"),
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("absent");
  });
});

describe("run_flows upload", () => {
  it("posts apk, flowsArchive and flows to /run and returns the job id without blocking", async () => {
    let seenPath = "";
    let seenForm: FormData | undefined;
    const result = await runFlows(fakeClient({
      postForm: async (p, form) => { seenPath = p; seenForm = form; return { id: "job-9", status: "queued" }; },
    }), { apkPath: apk, flows: ["map", "map/filter"], e2eDir: e2e });

    expect(seenPath).toBe("/run");
    expect(seenForm?.get("flows")).toBe(JSON.stringify(["map", "map/filter"]));
    expect(seenForm?.get("apk")).toBeInstanceOf(Blob);
    expect(seenForm?.get("flowsArchive")).toBeInstanceOf(Blob);
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("job-9");
    expect(text).toMatch(/wait_for_job/);
  });

  it("produces a real gzip archive from e2eDir", async () => {
    // Read the blob's bytes inside the fake postForm, while the temp
    // archive still exists - mirroring what a real fetch() does (it reads
    // the body before resolving), rather than after runFlows has returned
    // and its `finally` has already removed tempDir.
    let head: Buffer | undefined;
    await runFlows(fakeClient({
      postForm: async (_p, form) => {
        const archive = form.get("flowsArchive") as Blob;
        head = Buffer.from(await archive.slice(0, 2).arrayBuffer());
        return { id: "j", status: "queued" };
      },
    }), { apkPath: apk, flows: ["map"], e2eDir: e2e });
    expect(head![0]).toBe(0x1f);
    expect(head![1]).toBe(0x8b);
  });

  it("removes its temp archive even when the upload fails", async () => {
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("mcp-flows-")).length;
    const result = await runFlows(fakeClient({
      postForm: async () => { throw new Error("upload exploded"); },
    }), { apkPath: apk, flows: ["map"], e2eDir: e2e });
    expect(result.isError).toBe(true);
    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("mcp-flows-")).length;
    expect(after).toBe(before);
  });

  it("uses a caller-supplied archive as-is", async () => {
    const prebuilt = path.join(dir, "flows.tar.gz");
    fs.writeFileSync(prebuilt, Buffer.from([0x1f, 0x8b, 0x00]));
    let archive: Blob | undefined;
    await runFlows(fakeClient({
      postForm: async (_p, form) => { archive = form.get("flowsArchive") as Blob; return { id: "j", status: "queued" }; },
    }), { apkPath: apk, flows: ["map"], flowsArchive: prebuilt });
    expect(archive!.size).toBe(3);
  });
});
