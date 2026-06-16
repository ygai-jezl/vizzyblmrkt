/**
 * A brand's favicon, derived from its root domain. Pulled in automatically when
 * a tenant is created (see createTenant) so the admin shell always has a brand
 * mark to show — the favicon is never left blank.
 *
 * Google's s2 service is used because it returns a guaranteed-size PNG and
 * always responds (a generic globe rather than a 404), so the URL never
 * dead-links. The admin sidebar still renders a monogram fallback if the image
 * fails to load (see BrandFavicon).
 */
export function deriveFaviconUrl(rootDomain: string, size = 64): string {
  const host = rootDomain
    .trim()
    .replace(/^https?:\/\//, "") // strip scheme if a full URL was stored
    .replace(/\/.*$/, "") // strip any path
    .replace(/:\d+$/, ""); // strip a port
  if (!host) return "";
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=${size}`;
}
