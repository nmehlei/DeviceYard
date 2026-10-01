import { safeUrl, redactToken, type FarmClientConfig } from "./config";
import type { RunResponse } from "./apiTypes";

export type FarmErrorKind = "auth" | "not_found" | "unreachable" | "server" | "timeout";

export class FarmError extends Error {
  constructor(message: string, readonly kind: FarmErrorKind, readonly status?: number) {
    super(message);
    this.name = "FarmError";
  }
}

/** A byte range to ask for, expressed the way HTTP does: inclusive on both
 * ends, `end` omitted meaning "to the end of the resource". */
export interface ByteRange {
  start: number;
  end?: number;
}

export interface BinaryBody {
  bytes: Buffer;
  contentType: string;
  /** Size of the WHOLE artifact, not of `bytes`: taken from `Content-Range`
   * when the server honoured a range request, and otherwise equal to
   * `bytes.byteLength`, which is the whole thing by definition. A caller can
   * therefore always trust this number without knowing whether the server
   * supports ranges. */
  totalBytes: number;
  /** True only when the server answered 206 - i.e. `bytes` is a slice. A
   * server that ignores `Range` and replies 200 sets this false, and the
   * caller then already holds the complete body. */
  partial: boolean;
}

/** Per-call overrides of the client's defaults. */
export interface RequestOptions {
  /** Tighter than `config.timeoutMs` for one call. A caller that can simply
   * ask again (a poll loop) wants a stalled request to fail fast rather than
   * inherit a default sized for a slow upload. */
  timeoutMs?: number;
}

export interface FarmClient {
  getJson<T>(path: string, opts?: RequestOptions): Promise<T>;
  /** `range` is a hint, not a contract: a server free to ignore it answers
   * 200 with the whole body, which is why the result says which happened. */
  getBinary(path: string, range?: ByteRange): Promise<BinaryBody>;
  postForm(path: string, form: FormData): Promise<RunResponse>;
  openEvents(path: string, onFrame: (data: unknown) => void, signal: AbortSignal): Promise<void>;
}

/** `bytes <start>-<end>/<total>` - only the total is of interest here. */
function parseContentRangeTotal(header: string | null): number | undefined {
  if (!header) return undefined;
  const match = /\/\s*(\d+)\s*$/.exec(header);
  if (!match) return undefined;
  const total = Number(match[1]);
  return Number.isFinite(total) ? total : undefined;
}

export function createFarmClient(config: FarmClientConfig, orgId?: number): FarmClient {
  const clean = (text: string) => redactToken(text, config.token);
  const url = (path: string) => `${config.farmUrl}${path}`;

  /** One place converts a transport-level throw into a FarmError, so no
   * caller has to guess whether it is holding a TypeError, an AbortError or
   * a real HTTP failure - and so no raw error string carrying the request
   * (headers included) can escape unredacted. */
  const transportError = (err: unknown, path: string, timedOut: boolean, timeoutMs = config.timeoutMs): FarmError => {
    if (timedOut) {
      return new FarmError(`timed out after ${timeoutMs}ms calling ${safeUrl(url(path))}`, "timeout");
    }
    const detail = clean(err instanceof Error ? err.message : String(err));
    return new FarmError(`could not reach the farm at ${safeUrl(url(path))}: ${detail}`, "unreachable");
  };

  const check = async (res: Response, path: string): Promise<Response> => {
    if (res.ok) return res;
    const body = clean(await res.text().catch(() => "")).slice(0, 2000);
    const where = safeUrl(url(path));
    if (res.status === 401 || res.status === 403) {
      // The server's own reason ("not a member of that org", "this token
      // belongs to a person, not an org - name the org with the X-Org-Id
      // header", "login required"...) is the whole point of a 401/403 body -
      // swallowing it and printing a fixed "Check MOBILE_FARM_TOKEN" (wrong
      // advice for a PAT user, who never sets that variable) left every one
      // of those distinct reasons reaching the agent as the same generic,
      // misleading line. Surface the body; describeFarmError (tools/reads.ts)
      // adds any further hint, credential-agnostically.
      throw new FarmError(
        `the farm rejected the credential (HTTP ${res.status}) for ${where}${body ? `: ${body}` : ""}`,
        "auth",
        res.status,
      );
    }
    if (res.status === 404) {
      // The server deliberately does not distinguish "absent" from "owned by
      // another org"; neither does this message.
      throw new FarmError(`not found: ${where} (it may not exist, or belong to another org)`, "not_found", 404);
    }
    throw new FarmError(`the farm returned HTTP ${res.status} for ${where}: ${body}`, "server", res.status);
  };

  /** A 200 whose body is not JSON (a misconfigured MOBILE_FARM_URL landing
   * on the dashboard's HTML, a proxy interstitial) must not escape as a raw
   * SyntaxError: it would bypass the redaction funnel every other failure
   * goes through, and it tells the agent nothing about what went wrong. */
  const parseJson = <T>(text: string, path: string): T => {
    try {
      return JSON.parse(text) as T;
    } catch {
      const preview = clean(text).replace(/\s+/g, " ").trim().slice(0, 200);
      throw new FarmError(
        `the farm returned a non-JSON response for ${safeUrl(url(path))}` +
        `${preview ? `: ${preview}` : " (empty body)"}`,
        "server",
      );
    }
  };

  /** fetch's own `signal` is the only reliable way to bound a request that
   * has begun streaming a body; a wall-clock race would leave the socket
   * open. The timer covers everything `run` does - the status check and the
   * body read included - because a response whose headers arrive promptly
   * and whose body then stalls is exactly the failure MOBILE_FARM_TIMEOUT_MS
   * is documented to bound, and clearing the timer at headers-received would
   * leave that hang unbounded. */
  const withTimeout = async <T>(
    path: string,
    run: (signal: AbortSignal) => Promise<T>,
    timeoutMs = config.timeoutMs,
  ): Promise<T> => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      return await run(controller.signal);
    } catch (err) {
      throw err instanceof FarmError ? err : transportError(err, path, timedOut, timeoutMs);
    } finally {
      clearTimeout(timer);
    }
  };

  const headers = (): Record<string, string> => {
    const h: Record<string, string> = { Authorization: `Bearer ${config.token}` };
    // Only sent for a personal access token. An org token resolves its org
    // server-side and ignores this header, so omitting it when unscoped
    // keeps the cycle-5 CI path byte-identical to what it was before PATs.
    if (orgId !== undefined) h["X-Org-Id"] = String(orgId);
    return h;
  };

  return {
    async getJson<T>(path: string, opts?: RequestOptions): Promise<T> {
      return withTimeout(path, async (signal) => {
        const res = await fetch(url(path), { headers: headers(), signal });
        await check(res, path);
        return parseJson<T>(await res.text(), path);
      }, opts?.timeoutMs);
    },

    async getBinary(path, range) {
      return withTimeout(path, async (signal) => {
        const requestHeaders: Record<string, string> = { ...headers() };
        if (range) requestHeaders.Range = `bytes=${range.start}-${range.end ?? ""}`;
        const res = await fetch(url(path), { headers: requestHeaders, signal });
        await check(res, path);
        const partial = res.status === 206;
        const bytes = Buffer.from(await res.arrayBuffer());
        return {
          bytes,
          contentType: res.headers.get("content-type") ?? "application/octet-stream",
          // On a 200 the body IS the whole resource, so its length is the
          // total - which is what lets a caller treat a range-ignoring
          // server as merely wasteful rather than as a different code path.
          totalBytes: (partial ? parseContentRangeTotal(res.headers.get("content-range")) : undefined)
            ?? bytes.byteLength,
          partial,
        };
      });
    },

    async postForm(path, form) {
      return withTimeout(path, async (signal) => {
        const res = await fetch(url(path), { method: "POST", headers: headers(), body: form, signal });
        await check(res, path);
        return parseJson<RunResponse>(await res.text(), path);
      });
    },

    async openEvents(path, onFrame, signal) {
      // No per-request timeout here: the caller's own budget governs how
      // long it is willing to watch a job, and that budget is measured in
      // minutes, not in the single-request timeout.
      let res: Response;
      try {
        res = await fetch(url(path), { headers: headers(), signal });
      } catch (err) {
        if (signal.aborted) return;
        throw transportError(err, path, false);
      }
      await check(res, path);
      if (!res.body) return;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          // SSE frames are separated by a blank line; a frame can span
          // several chunks, so nothing is parsed until its terminator lands.
          let split: number;
          while ((split = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice("data:".length).trim())
              .join("\n");
            if (!data) continue;
            try {
              onFrame(JSON.parse(data));
            } catch {
              // A malformed frame is not worth tearing the stream down for.
            }
            if (signal.aborted) return;
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        throw transportError(err, path, false);
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    },
  };
}
