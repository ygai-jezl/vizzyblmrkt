/**
 * How a new brand's (tenant's) id and domain are derived from what a person types. Shared
 * by the "new brand" route and `npm run selfhost` (scripts/selfhost/create-workspace.ts), so
 * both name a brand the same way.
 */

/** Strip scheme/path so the stored domain is a bare host (for favicon + origin). */
export function normalizeDomain(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

/** Derive a global tenant id from the brand name; "" when nothing usable. */
export function slugifyTenantId(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return base ? `ten_${base}` : "";
}
