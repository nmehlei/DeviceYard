import { getArtifact, MAX_INLINE_IMAGE_BYTES, TEXT_TAIL_BYTES } from "../../src/mcp/tools/getArtifact";
import { FarmError, type ByteRange, type FarmClient } from "../../src/mcp/client";

interface Call {
  path: string;
  range?: ByteRange;
}

/** A fake that behaves like the real farm since commit 89e9a47: it honours
 * `Range` with a 206 and a `Content-Range` total. `calls` records exactly
 * how many bytes the tool actually asked for, which is the whole point of
 * these tests - "did not download it" is not observable any other way. */
function rangeAwareClient(body: Buffer, contentType: string) {
  const calls: Call[] = [];
  const client: FarmClient = {
    getJson: async () => ({}) as never,
    postForm: async () => ({ id: "x", status: "queued" }),
    openEvents: async () => undefined,
    getBinary: async (path, range) => {
      calls.push({ path, range });
      if (!range) {
        return { bytes: body, contentType, totalBytes: body.byteLength, partial: false };
      }
      const end = Math.min(range.end ?? body.byteLength - 1, body.byteLength - 1);
      if (range.start > end || range.start >= body.byteLength) {
        throw new FarmError("range not satisfiable", "server", 416);
      }
      return {
        bytes: body.subarray(range.start, end + 1),
        contentType,
        totalBytes: body.byteLength,
        partial: true,
      };
    },
  };
  return { client, calls, bytesFetched: () => calls.reduce((n, c) => {
    if (!c.range) return n + body.byteLength;
    const end = Math.min(c.range.end ?? body.byteLength - 1, body.byteLength - 1);
    return n + Math.max(0, end - c.range.start + 1);
  }, 0) };
}

/** A server that does NOT support Range: it ignores the header and returns
 * the whole body with a 200, which is what `partial: false` means. */
function rangeIgnoringClient(body: Buffer, contentType: string) {
  const calls: Call[] = [];
  const client: FarmClient = {
    getJson: async () => ({}) as never,
    postForm: async () => ({ id: "x", status: "queued" }),
    openEvents: async () => undefined,
    getBinary: async (path, range) => {
      calls.push({ path, range });
      return { bytes: body, contentType, totalBytes: body.byteLength, partial: false };
    },
  };
  return { client, calls };
}

const FARM = "https://farm.example";
const text = (result: { content: Array<{ type: string }> }, i = 0) =>
  (result.content[i] as unknown as { text: string }).text;

describe("getArtifact", () => {
  it("returns a png as image content with a caption naming the artifact", async () => {
    const { client } = rangeAwareClient(Buffer.from([1, 2]), "image/png");
    const result = await getArtifact(client, FARM, { artifactId: 7 });
    expect(text(result)).toContain("7");
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  it("returns a jpeg as image content", async () => {
    const { client } = rangeAwareClient(Buffer.from([1]), "image/jpeg");
    const result = await getArtifact(client, FARM, { artifactId: 8 });
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
  });

  it("fetches an under-cap image in full after the probe", async () => {
    const png = Buffer.alloc(4096, 7);
    const { client, calls } = rangeAwareClient(png, "image/png");
    const result = await getArtifact(client, FARM, { artifactId: 7 });
    expect(calls[0].range).toEqual({ start: 0, end: 0 });
    expect(calls[1].range).toBeUndefined();
    expect((result.content[1] as unknown as { data: string }).data)
      .toBe(png.toString("base64"));
  });

  it("refuses to inline an image over the cap and hands back size plus url instead", async () => {
    const big = Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1);
    const { client } = rangeAwareClient(big, "image/png");
    const result = await getArtifact(client, FARM, { artifactId: 9 });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(text(result)).toContain("too large");
    expect(text(result)).toContain("https://farm.example/api/artifacts/9");
    expect(result.isError).toBeUndefined();
  });

  it("does not download an over-cap image it has already decided not to inline", async () => {
    const big = Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1);
    const { client, calls, bytesFetched } = rangeAwareClient(big, "image/png");
    await getArtifact(client, FARM, { artifactId: 9 });
    expect(calls).toHaveLength(1);
    expect(bytesFetched()).toBe(1);
  });

  it("returns a log as tail-truncated text, not as an image", async () => {
    const log = Array.from({ length: 200 }, (_, i) => `line${i}`).join("\n");
    const { client } = rangeAwareClient(Buffer.from(log), "text/plain; charset=utf-8");
    const result = await getArtifact(client, FARM, { artifactId: 3 });
    expect(text(result)).toContain("line199");
    expect(text(result)).toContain("truncated");
    expect(result.content).toHaveLength(1);
  });

  it("fetches only the tail of a large text artifact, never the whole file", async () => {
    // 4 MB of log: the rendered output is at most 8000 characters, so pulling
    // all of it over the wire to throw 99.8% of it away is pure waste.
    const line = "x".repeat(99);
    const log = Array.from({ length: 40000 }, (_, i) => `${i}-${line}`).join("\n");
    const body = Buffer.from(log);
    expect(body.byteLength).toBeGreaterThan(4 * 1024 * 1024);

    const { client, calls, bytesFetched } = rangeAwareClient(body, "text/plain");
    const result = await getArtifact(client, FARM, { artifactId: 11 });

    expect(calls).toHaveLength(2);
    expect(calls[1].range).toEqual({ start: body.byteLength - TEXT_TAIL_BYTES, end: body.byteLength - 1 });
    expect(bytesFetched()).toBeLessThanOrEqual(TEXT_TAIL_BYTES + 1);
    // Still shows the end of the file, and still says it is truncated.
    expect(text(result)).toContain("39999-");
    expect(text(result)).toContain("truncated");
  });

  it("marks a range-truncated text artifact as truncated even when the tail itself fits", async () => {
    // A file whose last TEXT_TAIL_BYTES happen to be under both tail limits:
    // format.tail sees nothing to trim, so without an explicit marker the
    // agent would think it was handed the whole file.
    const head = Buffer.alloc(TEXT_TAIL_BYTES * 2, 0x61); // 'a', no newlines
    const body = Buffer.concat([head, Buffer.from("\nlast line\n")]);
    const { client } = rangeAwareClient(body, "text/plain");
    const result = await getArtifact(client, FARM, { artifactId: 12 });
    expect(text(result)).toContain("truncated");
    expect(text(result)).toContain("last line");
  });

  it("does not inline video, and says why", async () => {
    const { client } = rangeAwareClient(Buffer.from([0]), "video/mp4");
    const result = await getArtifact(client, FARM, { artifactId: 4 });
    expect(text(result)).toContain("video");
    expect(text(result)).toContain("https://farm.example/api/artifacts/4");
    expect(result.content).toHaveLength(1);
  });

  it("never downloads a recording, only probes it for type and size", async () => {
    // Cycle 4's recordings are 180s of screenrecord - tens of megabytes -
    // and the only thing this tool does with one is print a link.
    const recording = Buffer.alloc(30 * 1024 * 1024);
    const { client, calls, bytesFetched } = rangeAwareClient(recording, "video/mp4");
    const result = await getArtifact(client, FARM, { artifactId: 4 });
    expect(calls).toHaveLength(1);
    expect(calls[0].range).toEqual({ start: 0, end: 0 });
    expect(bytesFetched()).toBe(1);
    expect(text(result)).toContain(String(recording.byteLength));
  });

  it("still works when the server ignores Range and answers 200 with the whole body", async () => {
    const log = Array.from({ length: 200 }, (_, i) => `line${i}`).join("\n");
    const { client, calls } = rangeIgnoringClient(Buffer.from(log), "text/plain");
    const result = await getArtifact(client, FARM, { artifactId: 13 });
    // One request only: the probe already returned everything.
    expect(calls).toHaveLength(1);
    expect(text(result)).toContain("line199");
    expect(text(result)).toContain(String(Buffer.from(log).byteLength));
  });

  it("inlines an image from a range-ignoring server without a second fetch", async () => {
    const png = Buffer.alloc(64, 3);
    const { client, calls } = rangeIgnoringClient(png, "image/png");
    const result = await getArtifact(client, FARM, { artifactId: 14 });
    expect(calls).toHaveLength(1);
    expect((result.content[1] as unknown as { data: string }).data).toBe(png.toString("base64"));
  });

  it("handles a zero-byte artifact, whose probe range is unsatisfiable", async () => {
    const { client, calls } = rangeAwareClient(Buffer.alloc(0), "text/plain");
    const result = await getArtifact(client, FARM, { artifactId: 15 });
    expect(result.isError).toBeUndefined();
    expect(calls[1].range).toBeUndefined();
    expect(text(result)).toContain("0 bytes");
  });

  it("falls back to text for an unknown content type", async () => {
    const { client } = rangeAwareClient(Buffer.from("hi"), "application/octet-stream");
    const result = await getArtifact(client, FARM, { artifactId: 5 });
    expect(result.content[0].type).toBe("text");
  });

  it("rejects a non-numeric artifact id before calling the farm", async () => {
    const { client, calls } = rangeAwareClient(Buffer.alloc(1), "image/png");
    const result = await getArtifact(client, FARM, { artifactId: NaN });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("returns an error result for a missing artifact", async () => {
    const client: FarmClient = {
      ...rangeAwareClient(Buffer.alloc(0), "").client,
      getBinary: async () => { throw new FarmError("not found", "not_found", 404); },
    };
    const result = await getArtifact(client, FARM, { artifactId: 99 });
    expect(result.isError).toBe(true);
  });
});
