/** Shared validation only; device matching belongs to the edition scheduler. */
export function parseDeviceTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16 || value.some(tag =>
    typeof tag !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(tag))
    || new Set(value).size !== value.length) {
    throw new Error('Device tags must be an array of at most 16 unique lowercase tags (1–32 letters, digits or hyphens, starting with a letter or digit)');
  }
  return [...value];
}
