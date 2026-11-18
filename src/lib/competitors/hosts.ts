/** Hosts that only serve files (a PDF, an image) for whoever uploads them: their name says nothing about who is cited. */
const FILE_HOSTS = [
  "hubspotusercontent.net",
  "hubspotusercontent-na1.net",
  "hubspotusercontent-eu1.net",
  "hs-sites.com",
  "cloudfront.net",
  "amazonaws.com",
  "ctfassets.net",
  "googleusercontent.com",
  "storage.googleapis.com",
  "blob.core.windows.net",
];

/** "https://www.example.com/x" → "example.com"; "" when it isn't an address. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** A link to a file host rather than to someone's own site. Pure and client-safe. */
export function isFileHost(url: string): boolean {
  const host = domainOf(url);
  return Boolean(host) && FILE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}
