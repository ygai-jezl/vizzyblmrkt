import { platformOrigin } from "@/lib/platform/origin";

/**
 * Server switch: `/` is the YouGrow marketing homepage (the growth loop with SITE_LOOP_ENABLED,
 * else the earlier page). Off, `/` is a plain front page with a sign-in button, which is what a
 * self-hosted copy wants.
 */
export function isSiteHomeEnabled(): boolean {
  return process.env.SITE_HOME_ENABLED === "true";
}

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

/**
 * The public site's canonical origin: NEXT_PUBLIC_SITE_ORIGIN, else the platform origin. Set it
 * to point a staging copy's canonical links at the live site. Empty when neither is set: callers
 * then use relative links (the address the page was requested on) and nothing is canonical.
 */
export function siteOrigin(): string {
  return (process.env.NEXT_PUBLIC_SITE_ORIGIN ?? "").trim().replace(/\/+$/, "") || platformOrigin();
}

/** `metadataBase` for page metadata: the canonical origin when one is set, else none (Next's own default). */
export function siteMetadataBase(): URL | undefined {
  const origin = siteOrigin();
  if (!origin) return undefined;
  try {
    return new URL(origin);
  } catch {
    return undefined;
  }
}

/**
 * The waitlist campaign the marketing homepage embeds (its slug, e.g. "spring-launch"), served
 * by /embed.js from the site origin. Empty when unset: the homepage then shows no widget.
 */
export function siteWaitlistCampaign(): string {
  const slug = (process.env.SITE_WAITLIST_CAMPAIGN ?? "").trim();
  return /^[A-Za-z0-9_-]{1,100}$/.test(slug) ? slug : "";
}

/** The embed loader for the homepage widget: from the site origin, or this host when none is set. */
export function siteEmbedScriptSrc(): string {
  return `${siteOrigin()}/embed.js`;
}

/** True for a request to the canonical host; every other host (staging, *.hosted.app, localhost) is kept out of search. */
export function isCanonicalHost(host: string | null | undefined): boolean {
  const base = siteMetadataBase();
  if (!host || !base) return false;
  return host.trim().toLowerCase() === base.host.toLowerCase();
}
