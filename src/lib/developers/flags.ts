import { outboundIssuer } from "@/lib/connect/outboundSigner";

/** Server flag — the public /developers docs 404 when off. */
export function isDevelopersDocsEnabled(): boolean {
  return process.env.DEVELOPERS_DOCS_ENABLED === "true";
}

/**
 * The platform origin the docs show (API URLs, the JWKS, the issuer) — this
 * environment's own, so staging docs point at staging.
 */
export function docsOrigin(): string {
  try {
    return outboundIssuer();
  } catch {
    return "https://yougrow.ai";
  }
}

/** This environment's GitHub App page (public), when the app is configured. */
export function githubAppPublicUrl(): string | null {
  const slug = process.env.GITHUB_APP_SLUG?.trim();
  return slug && /^[a-z0-9-]{1,100}$/.test(slug) ? `https://github.com/apps/${slug}` : null;
}
