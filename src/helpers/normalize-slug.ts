export function normalizeSlug(value: string): string {
  return value
    .toLocaleLowerCase('de-DE')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}
