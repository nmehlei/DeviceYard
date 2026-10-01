import { FrameTag, tagFrame } from "../../src/control/frameTags";

test("prefixes exactly one tag byte and keeps the payload intact", () => {
  const out = tagFrame(FrameTag.Png, Uint8Array.from([9, 8, 7]));
  expect([...out]).toEqual([1, 9, 8, 7]);
});

test("tag values are the wire contract and must not drift", () => {
  expect(FrameTag).toEqual({ Png: 1, H264Config: 2, H264Key: 3, H264Delta: 4 });
});

test("an empty payload still carries its tag", () => {
  expect([...tagFrame(FrameTag.H264Delta, new Uint8Array())]).toEqual([4]);
});
