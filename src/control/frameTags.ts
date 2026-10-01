/**
 * One leading byte on every binary WebSocket frame says what follows.
 *
 * Plan A sent bare PNGs, which worked only because a socket carried one kind
 * of binary payload. With H.264 on the same socket, a frame arriving across a
 * mode transition could otherwise be decoded as the wrong thing; the mode
 * message and the media are ordered, but a tag makes each frame self-describing
 * regardless. dashboard/src/lib/frameTags.ts mirrors these values and
 * tests/control/frameTagsParity.test.ts keeps the two from drifting.
 */
export const FrameTag = { Png: 1, H264Config: 2, H264Key: 3, H264Delta: 4 } as const;
export type FrameTag = (typeof FrameTag)[keyof typeof FrameTag];

export function tagFrame(tag: FrameTag, payload: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(payload.length + 1);
  out[0] = tag;
  out.set(payload, 1);
  return out;
}
