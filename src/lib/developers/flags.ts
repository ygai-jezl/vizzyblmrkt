import { outboundIssuer } from "@/lib/connect/outboundSigner";
import { platformOrigin } from "@/lib/platform/origin";
import { DEFAULT_ORIGIN } from "../../../sdk/node/src/origin";

/** Server flag — the public /developers docs 404 when off. */
export function isDevelopersDocsEnabled(): boolean {
  return process.env.DEVELOPERS_DOCS_ENABLED === "true";
}

/** Where @yougrowai/node sends events and whose keys it trusts unless told otherwise (the SDK's own default). */
export const SDK_DEFAULT_ORIGIN = DEFAULT_ORIGIN;

/**
 * The platform origin the docs show (API URLs, the JWKS, the issuer): this
 * environment's own CONNECT_ISSUER, so staging docs point at staging. When that
 * isn't usable (a production deploy without CONNECT_ISSUER), the platform origin,
 * else the address the request came in on when the caller has one, else empty,
 * so the docs show paths on this host. (The docs pages render synchronously for
 * their Markdown twins, so they can't read the request themselves.)
 */
export function docsOrigin(requestOrigin = ""): string {
  try {
    return outboundIssuer();
  } catch {
    return platformOrigin() || requestOrigin.replace(/\/+$/, "");
  }
}

/** This environment's GitHub App page (public), when the app is configured. */
export function githubAppPublicUrl(): string | null {
  const slug = process.env.GITHUB_APP_SLUG?.trim();
  return slug && /^[a-z0-9-]{1,100}$/.test(slug) ? `https://github.com/apps/${slug}` : null;
}
