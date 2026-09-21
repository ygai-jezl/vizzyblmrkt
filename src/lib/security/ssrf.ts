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
  if (a === 192 && b === 0 && o[2] === 0) return true; // IETF assignments 192.0.0/24 (incl. NAT64 discovery)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * Expand an IPv6 address — with `::` compression, a trailing dotted IPv4
 * (`::ffff:1.2.3.4`) and/or a zone id (`fe80::1%eth0`) — into its eight 16-bit
 * groups. Null when malformed.
 */
function ipv6Groups(ip: string): number[] | null {
  let v = ip.split("%")[0] ?? "";
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  if (dotted) {
    const o = dotted[2]!.split(".").map(Number);
    if (o.some((n) => n > 255)) return null;
    v = `${dotted[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = v.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : head.length !== 8) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail].map(
    (h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN),
  );
  return groups.every((g) => Number.isInteger(g)) ? groups : null;
}

/** The IPv4 address carried in two 16-bit groups. */
function embeddedV4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

function isPrivateV6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return true; // malformed → reject defensively
  const [g0, g1, g2, , , g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const zeroes = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  // ::, ::1, and the deprecated IPv4-compatible ::a.b.c.d form.
  if (zeroes(0, 6)) return true;
  // IPv4-mapped ::ffff:a.b.c.d — judge the embedded IPv4.
  if (zeroes(0, 5) && g5 === 0xffff) return isPrivateV4(embeddedV4(g6, g7));
  // NAT64: the well-known prefix 64:ff9b::/96 embeds an IPv4 address; anything
  // else under 64:ff9b (incl. the local-use 64:ff9b:1::/48) is operator-defined.
  if (g0 === 0x64 && g1 === 0xff9b) return zeroes(2, 6) ? isPrivateV4(embeddedV4(g6, g7)) : true;
  // 6to4 2002::/16 embeds an IPv4 address in its next 32 bits.
  if (g0 === 0x2002) return isPrivateV4(embeddedV4(g1, g2));
  if (g0 === 0x2001 && g1 === 0) return true; // Teredo 2001::/32 (tunnelled; never needed)
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const fam = isIP(v);
  if (fam === 4) return isPrivateV4(v);
  if (fam === 6) return isPrivateV6(v);
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

/** Options shared by the URL screen and safeFetch. */
export interface SafeUrlOptions {
  /** When set, only these ports are allowed (an absent port means 443). */
  allowedPorts?: number[];
}

/**
 * Screen an outbound URL WITHOUT fetching it: https only, no localhost/internal
 * names, no private IP literals, and (optionally) an allowed port. Use it to
 * validate a tenant-supplied URL when it is SAVED; safeFetch re-applies it, plus
 * the connect-time IP check, on every call. Throws on a blocked URL.
 */
export function assertSafeHttpsUrl(raw: string, opts: SafeUrlOptions = {}): URL {
  return assertHttps(raw, opts);
}

function assertHttps(raw: string, opts: SafeUrlOptions = {}): URL {
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
  if (opts.allowedPorts) {
    const port = url.port ? Number(url.port) : 443;
    if (!opts.allowedPorts.includes(port)) throw new Error("port_blocked");
  }
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
  opts: { maxRedirects?: number; timeoutMs?: number } & SafeUrlOptions = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 4;
  let current = raw;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const url = assertHttps(current, opts);
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
