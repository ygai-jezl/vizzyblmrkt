/**
 * Classify an Idea Board link by host. "Flaky" social hosts (auth-walled / JS-only,
 * no static HTML) can't be fetched cleanly server-side — the UI nudges the user to
 * paste the text or add a screenshot for an accurate template. Other hosts are
 * auto-fetched for templatization. Pure + dependency-free (client + server).
 */
const FLAKY_HOSTS = new Set([
  "twitter.com",
  "x.com",
  "linkedin.com",
  "instagram.com",
  "facebook.com",
  "threads.net",
  "tiktok.com",
  "youtube.com",
  "youtu.be",
]);

export interface LinkSource {
  /** Bare host (www/mobile/m stripped), or null when the URL isn't valid http(s). */
  host: string | null;
  /** True when the page is worth auto-fetching server-side for templatization. */
  fetchable: boolean;
}

export function classifyLinkSource(url: string): LinkSource {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      return { host: null, fetchable: false };
    }
    host = u.hostname.toLowerCase().replace(/^(www|mobile|m)\./, "");
  } catch {
    return { host: null, fetchable: false };
  }
  return { host, fetchable: !FLAKY_HOSTS.has(host) };
}
