import { isTrustedClientIpEnabled, trustedProxyHops } from "./flags";

/**
 * The visitor's address, for per-visitor rate limits.
 *
 * X-Forwarded-For is a list. A visitor can send their own header and write anything at its
 * start; each proxy then adds the address it saw at the end. So:
 *
 *  - Switch off (TRUSTED_CLIENT_IP_ENABLED): the first valid entry, then x-real-ip, else
 *    "unknown". Easy to spoof; the IP independent caps in each route are the real backstop.
 *  - Switch on: the entry TRUSTED_PROXY_HOPS places from the right, the address Google's load
 *    balancer saw. With too few entries, or no valid address there, the rule above.
 *
 * Non IP junk folds into one "unknown" bucket, so nobody can mint a fresh bucket per request.
 * Once every 10 minutes an instance also logs the header's shape (never an address), so a
 * deployment can check TRUSTED_PROXY_HOPS before turning the switch on.
 */
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  const trusted = isTrustedClientIpEnabled();
  const hops = trustedProxyHops();
  if (xff) maybeLogForwardedShape(headers, xff, hops, trusted);
  if (trusted && xff) {
    const ip = entryFromRight(xff.split(","), hops);
    if (ip && isIpLiteral(ip)) return visitorKey(ip);
  }
  return firstValidIp(headers, xff);
}

/**
 * The trusted address as a per-visitor key. An IPv6 visitor usually holds a whole /64 and can send
 * from any address in it, so the key is the /64 ("2001:db8:1:2::/64"); otherwise each request could
 * pick a fresh bucket. An IPv4 address written as IPv6 (::ffff:a.b.c.d) keys as that IPv4 address.
 * Only for the trusted entry: with the switch off clientIp answers exactly as before.
 */
export function visitorKey(ip: string): string {
  if (ipv4Octets(ip)) return ip;
  const groups = ipv6Groups(ip);
  if (!groups) return ip;
  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (mapped) {
    const [, , , , , , hi = 0, lo = 0] = groups;
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

/** Loose IPv4/IPv6 literal check. Rejects spoofed non IP junk used as a key. */
export function isIpLiteral(s: string): boolean {
  if (!s) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    return s.split(".").every((o) => Number(o) <= 255);
  }
  return s.includes(":") && /^[0-9a-fA-F:.]+$/.test(s); // loose IPv6
}

/** The rule from before the switch: the first valid X-Forwarded-For entry, then x-real-ip. */
function firstValidIp(headers: Headers, xff: string | null): string {
  if (xff) {
    for (const hop of xff.split(",")) {
      const ip = hop.trim();
      if (isIpLiteral(ip)) return ip;
    }
  }
  const real = headers.get("x-real-ip")?.trim();
  return real && isIpLiteral(real) ? real : "unknown";
}

/** The entry `fromRight` places from the end (0 is the last), trimmed; null when there isn't one. */
function entryFromRight(entries: string[], fromRight: number): string | null {
  const entry = entries[entries.length - 1 - fromRight];
  return entry === undefined ? null : entry.trim();
}

// --- the shape sample -------------------------------------------------------------------------

/**
 * What an X-Forwarded-For entry is, without saying which address: a private range (RFC 1918,
 * loopback, link local, fc00::/7), Google's front end ranges (35.191.0.0/16, 130.211.0.0/22),
 * any other address, or not an address at all.
 */
export type AddressKind = "private" | "gfe" | "other" | "invalid";

/** One shape sample, as logged. Counts and kinds only: never an address. */
export interface ForwardedShapeSample {
  severity: "INFO";
  message: "forwarded_shape_sample";
  event: "forwarded_shape_sample";
  /** How many entries X-Forwarded-For has. */
  entries: number;
  /** The kind of each entry, in header order: the last MAX_SAMPLED_KINDS only. */
  kinds: AddressKind[];
  /** Whether CF-Connecting-IP was sent. */
  cfConnectingIp: boolean;
  /** Which entry matches CF-Connecting-IP, counted from the right (0 is the last); null for none. */
  cfFromRight: number | null;
  /** Whether x-real-ip was sent. */
  xRealIp: boolean;
  /** TRUSTED_PROXY_HOPS as read. */
  hops: number;
  /** The kind of the entry the switch reads ("missing" when there are too few entries). */
  hopKind: AddressKind | "missing";
  /** Whether TRUSTED_CLIENT_IP_ENABLED is on. */
  trustedClientIp: boolean;
}

export const SHAPE_SAMPLE_EVERY_MS = 10 * 60_000;
export const MAX_SAMPLED_KINDS = 10;

let lastShapeSampleAt: number | null = null;

/** Test helper: the next call logs a sample again. */
export function __resetForwardedShapeSample(): void {
  lastShapeSampleAt = null;
}

function maybeLogForwardedShape(headers: Headers, xff: string, hops: number, trusted: boolean): void {
  const now = Date.now();
  if (lastShapeSampleAt !== null && now - lastShapeSampleAt < SHAPE_SAMPLE_EVERY_MS) return;
  lastShapeSampleAt = now;
  try {
    console.info(JSON.stringify(forwardedShape(headers, xff, hops, trusted)));
  } catch {
    // A sample is never worth failing a request over.
  }
}

/** The shape of a request's forwarding headers. Exported for tests. */
export function forwardedShape(headers: Headers, xff: string, hops: number, trusted: boolean): ForwardedShapeSample {
  const entries = xff.split(",").map((e) => e.trim());
  const hopEntry = entryFromRight(entries, hops);
  const cf = headers.get("cf-connecting-ip")?.trim().toLowerCase() ?? null;
  let cfFromRight: number | null = null;
  if (cf) {
    for (let i = 0; i < entries.length; i++) {
      if (entryFromRight(entries, i)?.toLowerCase() === cf) {
        cfFromRight = i;
        break;
      }
    }
  }
  return {
    severity: "INFO",
    message: "forwarded_shape_sample",
    event: "forwarded_shape_sample",
    entries: entries.length,
    kinds: entries.slice(-MAX_SAMPLED_KINDS).map(addressKind),
    cfConnectingIp: headers.has("cf-connecting-ip"),
    cfFromRight,
    xRealIp: headers.has("x-real-ip"),
    hops,
    hopKind: hopEntry === null ? "missing" : addressKind(hopEntry),
    trustedClientIp: trusted,
  };
}

/** Which kind of address an entry is. Exported for tests. */
export function addressKind(entry: string): AddressKind {
  const s = entry.trim();
  const v4 = ipv4Octets(s);
  if (v4) return ipv4Kind(v4);
  if (!isIpLiteral(s)) return "invalid";
  const groups = ipv6Groups(s);
  return groups ? ipv6Kind(groups) : "invalid";
}

function ipv4Octets(s: string): [number, number, number, number] | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return null;
  const [a = 0, b = 0, c = 0, d = 0] = s.split(".").map(Number);
  return [a, b, c, d].every((n) => n <= 255) ? [a, b, c, d] : null;
}

function ipv4Kind([a, b, c]: [number, number, number, number]): AddressKind {
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private"; // RFC 1918
  if (a === 127) return "private"; // loopback
  if (a === 169 && b === 254) return "private"; // link local
  if (a === 35 && b === 191) return "gfe"; // 35.191.0.0/16
  if (a === 130 && b === 211 && c <= 3) return "gfe"; // 130.211.0.0/22
  return "other";
}

/** The eight 16 bit groups of an IPv6 address (with :: and a dotted IPv4 tail); null when malformed. */
function ipv6Groups(s: string): number[] | null {
  let v = s.toLowerCase();
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  if (dotted) {
    const o = ipv4Octets(dotted[2] ?? "");
    if (!o) return null;
    v = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = v.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : head.length !== 8) return null;
  const groups = [...head, ...new Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function ipv6Kind(g: number[]): AddressKind {
  const [g0 = 0, , , , , g5 = 0, g6 = 0, g7 = 0] = g;
  const zeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroUpTo(7) && g7 === 1) return "private"; // ::1, loopback
  if ((g0 & 0xffc0) === 0xfe80) return "private"; // fe80::/10, link local
  if ((g0 & 0xfe00) === 0xfc00) return "private"; // fc00::/7, unique local
  if (zeroUpTo(5) && g5 === 0xffff) {
    // ::ffff:a.b.c.d, an IPv4 address written as IPv6
    return ipv4Kind([g6 >> 8, g6 & 255, g7 >> 8, g7 & 255]);
  }
  return "other";
}
