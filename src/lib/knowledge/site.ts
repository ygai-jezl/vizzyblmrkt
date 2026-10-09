import { getDomain } from "tldts";

/**
 * Which SITE a page is on: its registrable domain, by the public-suffix list (tldts).
 * `docs.brand.co.uk` and `brand.co.uk` are one site; `brand.co.uk` and `other.co.uk` are
 * two. A hosting platform that gives each customer a sub-domain (github.io, vercel.app)
 * is a suffix in that list, so two of its customers are never one site.
 *
 * Used to tell the brand's own pages from everyone else's — a page is only ever called
 * the brand's own when it is on the brand's site. Server-side: the suffix list is not
 * something to ship to a browser.
 */

/** Publishing platforms the suffix list leaves out, where each sub-domain is a different
 *  author. Two blogs on one of these are two sites. */
const SHARED_PLATFORMS = new Set([
  "substack.com",
  "medium.com",
  "beehiiv.com",
  "hashnode.dev",
  "tumblr.com",
  "wordpress.com",
  "blogspot.com",
  "notion.site",
]);

/** The site a URL (or a bare host) is on, lower-case, or "" when it names no host. */
export function siteOf(urlOrHost: string): string {
  const raw = (urlOrHost ?? "").trim();
  if (!raw) return "";
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname;
  } catch {
    return "";
  }
  host = host.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
  if (!host) return "";
  const domain = getDomain(host, { allowPrivateDomains: true });
  // An address with no registrable domain (an IP, a bare suffix) is only ever itself.
  if (!domain || SHARED_PLATFORMS.has(domain)) return host;
  return domain;
}

/**
 * The domains a tenant's own record vouches for as the brand's: its root domain, the
 * origins it allow-listed, and the sending domains it verified (one still being verified
 * proves nothing yet). Structural, so a partial record (or none) gives what it can.
 */
export function tenantDomains(
  tenant:
    | {
        rootDomain?: string | null;
        allowedOrigins?: string[] | null;
        emailSenderConfig?: { domains?: { domain: string; status?: string }[] | null } | null;
      }
    | null
    | undefined,
): string[] {
  if (!tenant) return [];
  const verified = (tenant.emailSenderConfig?.domains ?? []).filter((d) => d.status === "verified").map((d) => d.domain);
  return [tenant.rootDomain ?? "", ...(tenant.allowedOrigins ?? []), ...verified].filter(Boolean);
}

/** The sites these URLs are on, without the ones that name no host. */
export function sitesOf(urls: (string | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const u of urls) {
    const s = u ? siteOf(u) : "";
    if (s) out.add(s);
  }
  return out;
}
