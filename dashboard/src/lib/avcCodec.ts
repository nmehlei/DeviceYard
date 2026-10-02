const hex = (byte: number) => byte.toString(16).padStart(2, "0");

/**
 * WebCodecs needs "avc1.PPCCLL" - profile_idc, constraint flags, level_idc -
 * which live in the three bytes after the SPS NAL header. scrcpy sends SPS and
 * PPS together as the configuration packet, in Annex B (start-code delimited).
 */
export function codecStringFromAnnexB(config: Uint8Array): string | undefined {
  for (let i = 0; i + 3 < config.length; i++) {
    const startCode3 = config[i] === 0 && config[i + 1] === 0 && config[i + 2] === 1;
    if (!startCode3) continue;
    const header = i + 3;
    if ((config[header] & 0x1f) !== 7) continue; // not an SPS
    if (header + 3 >= config.length) return undefined;
    return `avc1.${hex(config[header + 1])}${hex(config[header + 2])}${hex(config[header + 3])}`;
  }
  return undefined;
}
