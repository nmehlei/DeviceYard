import { log } from "../telemetry/log";
import type { ControlPacket, ControlStream, StartControlStream } from "./controlStream";
import { SCRCPY_SERVER_DEVICE_PATH, readVerifiedScrcpyServer } from "./scrcpyServer";

/**
 * Under `module: commonjs`, tsc compiles `await import(x)` to `require(x)`,
 * which cannot load these ESM-only packages without require(esm). Building the
 * import inside Function keeps a REAL dynamic import in the emitted JavaScript.
 * tests/control/scrcpyEsmBoundary.test.ts proves it loads under real Node.
 */
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importEsm = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;

/**
 * D-12: audio is OFF explicitly - an audio stream is a second encoder session.
 * maxSize scales the long edge (504x1080 measured on a 1080x2316 display).
 */
export const SCRCPY_OPTIONS = {
  audio: false,
  control: true,
  video: true,
  maxSize: 1080,
  videoBitRate: 2_000_000,
} as const;

/**
 * Starts a scrcpy session through the local adb server - the same daemon the
 * farm's `adb` CLI uses, so the two coexist rather than contend for the device.
 * Every call below was verified against a real device before this was written.
 */
export const startScrcpyControlStream: StartControlStream = async (deviceId) => {
  const [adbModule, tcpModule, scrcpyModule, streamModule] = await Promise.all([
    importEsm("@yume-chan/adb"),
    importEsm("@yume-chan/adb-server-node-tcp"),
    importEsm("@yume-chan/adb-scrcpy"),
    importEsm("@yume-chan/stream-extra"),
  ]);

  const server = new adbModule.AdbServerClient(
    new tcpModule.AdbServerNodeTcpConnector({ host: "127.0.0.1", port: 5037 })
  );
  const adb = await server.createAdb({ serial: deviceId });

  const bytes = await readVerifiedScrcpyServer();
  await scrcpyModule.AdbScrcpyClient.pushServer(
    adb,
    new streamModule.ReadableStream({
      start(controller: { enqueue(chunk: Uint8Array): void; close(): void }) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    SCRCPY_SERVER_DEVICE_PATH
  );

  const options = new scrcpyModule.AdbScrcpyOptions3_3_2(SCRCPY_OPTIONS);
  let client;
  try {
    client = await scrcpyModule.AdbScrcpyClient.start(adb, SCRCPY_SERVER_DEVICE_PATH, options);
  } catch (startError) {
    // start() can reject after the server process was already spawned on the
    // device (e.g. the socket handshake times out) - there is no `client` to
    // call .close() on in that case. Best-effort kill it directly so a failed
    // start does not leave an orphaned scrcpy server on a shared device.
    const noneProtocol = adb.subprocess.noneProtocol;
    if (!noneProtocol) {
      log.error("scrcpy start failed and no shell channel is available for cleanup; server may be orphaned on device", {
        deviceId,
        startError: String(startError),
      });
      throw startError;
    }
    try {
      await noneProtocol.spawnWaitText(["pkill", "-f", "scrcpy-server"]);
    } catch (cleanupError) {
      log.error("scrcpy start failed and best-effort cleanup also failed; server may be orphaned on device", {
        deviceId,
        startError: String(startError),
        cleanupError: String(cleanupError),
      });
      throw startError;
    }
    log.error("scrcpy start failed; sent best-effort pkill for orphaned server", {
      deviceId,
      startError: String(startError),
    });
    throw startError;
  }

  // The server's log must be drained or its process can block on a full pipe.
  void (async () => {
    const reader = client.output.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      if (/ERROR|Exception/i.test(value)) log.error("scrcpy server", { deviceId, line: value });
    }
  })().catch(() => {});

  const video = await client.videoStream;
  // metadata, NOT video.width/height: the getters measured 0x0 at this point.
  const width = video.metadata.width;
  const height = video.metadata.height;
  if (!width || !height) {
    await client.close();
    throw new Error(`scrcpy reported no video size for ${deviceId}`);
  }

  // One reader, one loop, no timeouts: a read that loses a race against a timer
  // still consumes the next packet when it resolves.
  async function* packets(): AsyncGenerator<ControlPacket> {
    const reader = video.stream.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        if (value.type === "configuration") yield { kind: "config", data: value.data };
        else yield { kind: value.keyframe ? "key" : "delta", data: value.data };
      }
    } finally {
      reader.releaseLock();
    }
  }

  const controller = client.controller;
  if (!controller) {
    await client.close();
    throw new Error(`scrcpy started without a control channel for ${deviceId}`);
  }

  const stream: ControlStream = {
    width,
    height,
    packets: packets(),
    input: controller,
    resetVideo: () => controller.resetVideo(),
    closed: client.exited,
    close: () => client.close(),
  };
  return stream;
};
