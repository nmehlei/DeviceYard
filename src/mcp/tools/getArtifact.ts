import { FarmError, type BinaryBody, type FarmClient } from "../client";
import { tail, TRUNCATION_MARKER } from "../format";
import { imageResult, textResult, errorResult, type ToolResult } from "../result";
import { describeFarmError } from "./reads";

/** An artifact is a screenshot of a phone, not a photograph - well under
 * this in practice. The cap exists so a pathological file cannot blow a
 * context window open in a single tool call. */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

/** How much of a text artifact's tail to pull down. Only the last 100 lines
 * or 8000 characters are ever rendered (see format.tail), and 8000
 * characters cannot occupy more than 32000 bytes even as 4-byte UTF-8, so
 * this window always contains everything that will be shown - while keeping
 * a multi-megabyte maestro.log off the wire entirely. */
export const TEXT_TAIL_BYTES = 64 * 1024;

const INLINE_IMAGE_TYPES = ["image/png", "image/jpeg"];

export async function getArtifact(
  client: FarmClient,
  farmUrl: string,
  args: { artifactId: number },
): Promise<ToolResult> {
  const id = Number(args.artifactId);
  if (!Number.isInteger(id) || id <= 0) {
    return errorResult(`artifactId must be a positive integer (got ${String(args.artifactId)})`);
  }

  const path = `/api/artifacts/${id}`;
  // Built without credentials: this URL is for a human to open in a browser
  // where they already have a session, never a way to pass the token along.
  const humanUrl = `${farmUrl.replace(/\/+$/, "")}${path}`;

  try {
    // One byte is enough to learn the content type and - via Content-Range -
    // the total size. Deciding what to do with an artifact must not cost the
    // artifact: a 180-second screen recording is tens of megabytes, and the
    // only thing this tool ever does with one is print a link to it.
    // A server that ignores Range answers 200 with the whole body instead;
    // `partial` says which happened, and every branch below is written to
    // work either way.
    const probe = await probeArtifact(client, path);
    const mime = probe.contentType.split(";")[0].trim().toLowerCase();
    const total = probe.totalBytes;
    const haveWholeBody = !probe.partial;
    const label = `artifact ${id} (${mime}, ${total} bytes)`;

    if (INLINE_IMAGE_TYPES.includes(mime)) {
      if (total > MAX_INLINE_IMAGE_BYTES) {
        return textResult(
          `artifact ${id} is a ${mime} of ${total} bytes, too large to inline ` +
          `(cap ${MAX_INLINE_IMAGE_BYTES} bytes). Open it at ${humanUrl}`,
        );
      }
      const bytes = haveWholeBody ? probe.bytes : (await client.getBinary(path)).bytes;
      return imageResult(bytes, mime, `artifact ${id} (${mime}, ${bytes.byteLength} bytes)`);
    }

    if (mime.startsWith("video/")) {
      return textResult(
        `artifact ${id} is a ${mime} recording of ${total} bytes. ` +
        `Video cannot be returned inline; open it at ${humanUrl}`,
      );
    }

    // Everything else - maestro.log, stdout, stderr, hierarchy dumps - is
    // text, and text is the format an agent can actually reason about.
    const { text, rangeTruncated } = await readTextTail(client, path, probe.bytes, total, haveWholeBody);
    let rendered = tail(text);
    if (rangeTruncated && !rendered.startsWith(TRUNCATION_MARKER)) {
      // The bytes never fetched are still bytes the agent is not seeing; the
      // marker is what tells it to go and get the whole file.
      rendered = `${TRUNCATION_MARKER}\n${rendered}`;
    }
    return textResult(`${label}\n\n${rendered}`);
  } catch (err) {
    return errorResult(describeFarmError(err));
  }
}

/** A zero-byte artifact (an empty stderr.log is routine) has no byte 0, so
 * the probe's `bytes=0-0` is unsatisfiable and a correct server answers 416.
 * That is not a failure of the artifact - fall back to fetching it whole,
 * which for an empty file costs nothing. */
async function probeArtifact(client: FarmClient, path: string): Promise<BinaryBody> {
  try {
    return await client.getBinary(path, { start: 0, end: 0 });
  } catch (err) {
    if (err instanceof FarmError && err.status === 416) return client.getBinary(path);
    throw err;
  }
}

async function readTextTail(
  client: FarmClient,
  path: string,
  probeBytes: Buffer,
  total: number,
  haveWholeBody: boolean,
): Promise<{ text: string; rangeTruncated: boolean }> {
  if (haveWholeBody) return { text: probeBytes.toString("utf8"), rangeTruncated: false };

  const start = Math.max(0, total - TEXT_TAIL_BYTES);
  const slice = await client.getBinary(path, { start, end: Math.max(start, total - 1) });
  if (start === 0 || !slice.partial) {
    return { text: slice.bytes.toString("utf8"), rangeTruncated: false };
  }
  // A window that starts mid-file starts mid-line, and possibly mid-UTF-8
  // sequence. Dropping through the first newline costs one partial line and
  // avoids rendering a replacement character as if it were file content.
  const raw = slice.bytes.toString("utf8");
  const firstBreak = raw.indexOf("\n");
  return { text: firstBreak === -1 ? raw : raw.slice(firstBreak + 1), rangeTruncated: true };
}
