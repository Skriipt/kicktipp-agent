export function escapeCssValue(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
