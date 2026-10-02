// Mirrors src/control/frameTags.ts. tests/control/frameTagsParity.test.ts in
// the backend reads this file and fails if the values drift apart.
export const FrameTag = { Png: 1, H264Config: 2, H264Key: 3, H264Delta: 4 } as const;
export type FrameTag = (typeof FrameTag)[keyof typeof FrameTag];

const KNOWN = new Set<number>(Object.values(FrameTag));

export function readFrameTag(frame: Uint8Array): { tag: FrameTag; payload: Uint8Array } | undefined {
  if (frame.length === 0 || !KNOWN.has(frame[0])) return undefined;
  return { tag: frame[0] as FrameTag, payload: frame.subarray(1) };
}
