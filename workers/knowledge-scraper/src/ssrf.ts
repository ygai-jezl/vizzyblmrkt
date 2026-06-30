import { lookup } from "node:dns/promises";

/**
 * Re-validate a URL at fetch time (defence in depth — the dispatch route already
 * screened literal hosts, but DNS can rebind between then and now). Resolves the
 * host and rejects if ANY resolved address is loopback / private / link-local /
 * unique-local. Used before every worker fetch of an operator-supplied URL.
 */

function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) {
    return true;
  }
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) → unwrap.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  const ipv4 = mapped ? mapped[1] : v;
  if (/^127\./.test(ipv4)) return true;
  if (/^10\./.test(ipv4)) return true;
  if (/^192\.168\./.test(ipv4)) return true;
  if (/^169\.254\./.test(ipv4)) return true; // link-local incl. 169.254.169.254 metadata
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ipv4)) return true;
  if (/^0\./.test(ipv4)) return true;
  return false;
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid_url: ${raw}`);
  }
  if (url.protocol !== "https:") throw new Error(`scheme_not_https: ${url.protocol}`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // Reject literal private hosts up front.
  if (host === "localhost" || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error(`host_blocked: ${host}`);
  }
  const addrs = await lookup(host, { all: true });
  if (addrs.length === 0) throw new Error(`host_unresolved: ${host}`);
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error(`host_private: ${host} -> ${a.address}`);
  }
  return url;
}

/**
 * Fetch with MANUAL redirect handling so every hop is re-validated against the
 * SSRF screen — `redirect: "follow"` would let a public URL 30x-redirect to a
 * private/metadata host undetected. Returns the final Response, or throws.
 */
export async function safeFetch(
  raw: string,
  init: RequestInit = {},
  maxRedirects = 4,
): Promise<Response> {
  let current = raw;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const url = await assertPublicUrl(current);
    const res = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: init.signal ?? AbortSignal.timeout(20_000),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      current = new URL(loc, url).toString();
      continue;
    }
    return res;
  }
  throw new Error("too_many_redirects");
}
