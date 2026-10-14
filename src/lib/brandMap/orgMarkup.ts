import type { BrandMapDecided } from "@/lib/types/brandMap";

/**
 * The Organization markup for the brand's home page, built from the saved brand map.
 * Google's guidance puts Organization markup on the home page (or one page about the
 * organisation), with `sameAs` for its profile pages. Its `@id` is the one every article's
 * markup points its publisher at, so the two describe one organisation. Pure + client-safe.
 */
export function organizationJsonLd(d: Pick<BrandMapDecided, "identity">): Record<string, unknown> | null {
  const name = d.identity.name.trim();
  const url = d.identity.site.trim().replace(/\/+$/, "");
  if (!name || !/^https:\/\//i.test(url)) return null;
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${url}/#organization`,
    name,
    url,
    ...(d.identity.statement ? { description: d.identity.statement } : {}),
    ...(d.identity.profiles.length ? { sameAs: d.identity.profiles.map((p) => p.url) } : {}),
  };
}
