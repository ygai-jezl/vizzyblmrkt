import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import { Agent } from "undici";

/**
 * SSRF-safe outbound fetch for server-side retrieval of operator-supplied URLs
 * (e.g. templatizing a pasted article link). Hardened against DNS rebinding by
 * validating the IP AT CONNECT TIME via an undici Agent `lookup` hook — every
 * socket (including each redirect hop) only connects to a vetted PUBLIC address,
 * so a public hostname that resolves to 169.254.169.254 / 10.x / ::1 / mapped
 * private ranges is rejected at the point of connection (not just on the textual
 * hostname). Redirects are followed manually so https + the host screen re-apply
 * per hop, and the body is read with a hard byte cap (decompression-bomb safe).
 */

function isPrivateV4(ip: string): boolean {
  const o = ip.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = o as [number, number, number, number];
  if (a === 0 || a === 127) return true; // unspecified / loopback (entire /8)
  if (a === 10) return true;
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true; // multicast + reserved
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const fam = isIP(v);
  if (fam === 4) return isPrivateV4(v);
  if (fam === 6) {
    if (v === "::1" || v === "::") return true;
    if (/^f[cd]/.test(v)) return true; // fc00::/7 unique-local
    if (/^fe[89ab]/.test(v)) return true; // fe80::/10 link-local
    const m = /^::ffff:(.+)$/.exec(v); // IPv4-mapped IPv6
    if (m && m[1]) {
      const inner = m[1];
      if (isIP(inner) === 4) return isPrivateV4(inner);
      const parts = inner.split(":");
      if (parts.length === 2) {
        const hi = parseInt(parts[0] ?? "", 16);
        const lo = parseInt(parts[1] ?? "", 16);
        if (Number.isFinite(hi) && Number.isFinite(lo)) {
          return isPrivateV4(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
        }
      }
    }
    return false;
  }
  return true; // not a parseable IP → reject defensively
}

type LookupCb = (
  err: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void;

/** DNS lookup that rejects if ANY resolved address is private — used by undici at
 *  connect time, so the validated address is exactly the one connected to. */
function safeLookup(hostname: string, options: { all?: boolean }, callback: LookupCb): void {
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = Array.isArray(addresses) ? addresses : [];
    if (list.length === 0) return callback(new Error("host_unresolved"), "", 0);
    for (const a of list) {
      if (isPrivateIp(a.address)) {
        return callback(new Error(`ssrf_blocked:${a.address}`), "", 0);
      }
    }
    if (options?.all) return callback(null, list);
    const first = list[0]!;
    callback(null, first.address, first.family);
  });
}

const safeAgent = new Agent({ connect: { lookup: safeLookup } });

type FetchInit = RequestInit & { dispatcher?: unknown };

function assertHttps(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid_url");
  }
  if (url.protocol !== "https:") throw new Error("scheme_not_https");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error("host_blocked");
  }
  // An IP-LITERAL host bypasses the undici connect-time `lookup` hook entirely — Node does
  // no DNS resolution when the host is already an IP, so safeLookup/isPrivateIp never run for
  // it. Screen private/loopback/link-local literals HERE (v4 and v6, brackets already stripped),
  // or a `https://127.0.0.1:.../` `https://10.x/`, `https://[::1]/` etc. would connect straight
  // through — including via a redirect Location header, which re-enters assertHttps per hop.
  if (isIP(host) && isPrivateIp(host)) throw new Error("host_blocked");
  return url;
}

/**
 * SSRF-safe fetch with manual, capped redirect handling. Throws on a private host,
 * non-https, or too many redirects. The undici Agent validates the connected IP on
 * every hop.
 */
export async function safeFetch(
  raw: string,
  init: RequestInit = {},
  opts: { maxRedirects?: number; timeoutMs?: number } = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 4;
  let current = raw;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const url = assertHttps(current);
    const res = await fetch(url, {
      ...init,
      dispatcher: safeAgent,
      redirect: "manual",
      signal: init.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 8000),
    } as FetchInit);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      current = new URL(loc, url).toString();
      continue;
    }
    return res;
  }
  throw new Error("too_many_redirects");
}

/** Read a response body as UTF-8 text, aborting once `maxBytes` (DECODED) is hit. */
export async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read a response body as raw bytes, ABORTING and returning null once `maxBytes` is exceeded
 * (so an oversized image never fully buffers). Used to pull favicon/og-image bytes for a
 * vision pass. Returns null on empty/oversized bodies.
 */
export async function readBytesCapped(res: Response, maxBytes: number): Promise<Buffer | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return null; // oversized — reject rather than truncate binary
      }
      chunks.push(Buffer.from(value));
    }
  }
  const buf = Buffer.concat(chunks);
  return buf.length ? buf : null;
}
