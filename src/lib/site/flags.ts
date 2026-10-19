import { platformOrigin } from "@/lib/platform/origin";

/** Server switch: robots.txt, sitemap.xml, schema.org JSON-LD and the site part of llms.txt. */
export function isSiteSeoEnabled(): boolean {
  return process.env.SITE_SEO_ENABLED === "true";
}

/** Server switch: the growth-loop homepage and the stage and feature pages. Off, `/` is the current homepage. */
export function isSiteLoopEnabled(): boolean {
  return process.env.SITE_LOOP_ENABLED === "true";
}

/** Server switch: the site in Spanish, French, German, Japanese and Arabic. Needs the loop pages. */
export function isSiteLanguagesEnabled(): boolean {
  return isSiteLoopEnabled() && process.env.SITE_LANGUAGES_ENABLED === "true";
}

/** The public site's canonical origin: the platform origin, else yougrow.ai (so staging points search engines at prod). */
export function siteOrigin(): string {
  return platformOrigin() || "https://yougrow.ai";
}

/** True for a request to the canonical host; every other host (staging, *.hosted.app, localhost) is kept out of search. */
export function isCanonicalHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const want = new URL(siteOrigin()).host.toLowerCase();
  return host.trim().toLowerCase() === want;
}
