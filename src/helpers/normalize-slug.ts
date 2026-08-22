// Kicktipp builds community URL slugs by stripping underscores and turning
// spaces into hyphens, so names and slugs only match once those are removed.
export function normalizeSlug(s: string): string {
  return s.toLowerCase().replace(/[ _-]/g, '');
}
