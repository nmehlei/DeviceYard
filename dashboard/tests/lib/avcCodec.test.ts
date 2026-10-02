import { codecStringFromAnnexB } from "../../src/lib/avcCodec";

// SPS NAL header 0x67, then profile_idc, constraint flags, level_idc.
const sps = (profile: number, constraints: number, level: number) =>
  [0x00, 0x00, 0x00, 0x01, 0x67, profile, constraints, level, 0xac, 0xd9];
const pps = [0x00, 0x00, 0x00, 0x01, 0x68, 0xeb, 0xe3, 0xcb];

test("reads profile, constraints and level from the SPS", () => {
  expect(codecStringFromAnnexB(Uint8Array.from([...sps(0x42, 0xc0, 0x1f), ...pps]))).toBe("avc1.42c01f");
});

test("finds the SPS behind a three-byte start code and after other NAL units", () => {
  const threeByte = [0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x28];
  expect(codecStringFromAnnexB(Uint8Array.from([...pps, ...threeByte]))).toBe("avc1.640028");
});

test("is undefined when there is no SPS", () => {
  expect(codecStringFromAnnexB(Uint8Array.from(pps))).toBeUndefined();
  expect(codecStringFromAnnexB(new Uint8Array())).toBeUndefined();
});

test("is undefined for a truncated SPS rather than reading past the end", () => {
  expect(codecStringFromAnnexB(Uint8Array.from([0x00, 0x00, 0x01, 0x67, 0x42]))).toBeUndefined();
});
