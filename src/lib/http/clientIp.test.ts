import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetForwardedShapeSample,
  addressKind,
  clientIp,
  forwardedShape,
  isIpLiteral,
  MAX_SAMPLED_KINDS,
  SHAPE_SAMPLE_EVERY_MS,
  visitorKey,
} from "./clientIp";
import { DEFAULT_TRUSTED_PROXY_HOPS, isTrustedClientIpEnabled, trustedProxyHops } from "./flags";
import { clientIp as clientIpFromViewIngest, isIpLiteral as isIpLiteralFromViewIngest } from "@/lib/analytics/viewIngest";

// Documentation ranges (RFC 5737, RFC 3849) stand in for visitors; 35.191.x.x is Google's
// front end range, which the shape sample names "gfe".
const CLIENT = "203.0.113.7";
const SPOOFED = "198.51.100.9";
const LB = "192.0.2.10";
const GFE = "35.191.4.5";
const CLIENT6 = "2001:db8::7";
const SPOOFED6 = "2001:db8::bad";

/** clientIp exactly as it was before the switch, kept here to prove "off" changes nothing. */
function legacyClientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    for (const hop of xff.split(",")) {
      const ip = hop.trim();
      if (isIpLiteral(ip)) return ip;
    }
  }
  const real = headers.get("x-real-ip")?.trim();
  return real && isIpLiteral(real) ? real : "unknown";
}

const h = (init: Record<string, string>) => new Headers(init);
const xff = (value: string, extra: Record<string, string> = {}) => h({ "x-forwarded-for": value, ...extra });

/** Header shapes every rule must handle: App Hosting's, spoofed, junk, IPv6, empty. */
const SHAPES: Headers[] = [
  xff(`${CLIENT}, ${LB}, ${GFE}`),
  xff(`${SPOOFED}, ${CLIENT}, ${LB}, ${GFE}`),
  xff(`not-an-ip, ${CLIENT}, ${LB}, ${GFE}`),
  xff(`${SPOOFED},, ${CLIENT}, ${LB}, ${GFE}`),
  xff(`1.1.1.1, 2.2.2.2, 3.3.3.3, ${CLIENT}, ${LB}, ${GFE}`),
  xff(`${SPOOFED},${CLIENT},${LB},${GFE}`),
  xff(`${CLIENT6}, ${LB}, ${GFE}`),
  xff(`${SPOOFED6}, ${CLIENT6}, ${LB}, ${GFE}`),
  xff(`${SPOOFED}, junk, ${LB}, ${GFE}`),
  xff(`junk, also junk, ${LB}, ${GFE}`),
  xff(`${CLIENT}, ${GFE}`),
  xff(GFE),
  xff("not-an-ip-xyz"),
  xff("999.1.1.1, 300.2.2.2"),
  xff(""),
  xff("   "),
  xff(",,,"),
  xff(`${CLIENT}, ${LB}, ${GFE}`, { "x-real-ip": SPOOFED }),
  xff("junk", { "x-real-ip": CLIENT }),
  xff("junk", { "x-real-ip": "junk" }),
  h({ "x-real-ip": ` ${CLIENT} ` }),
  h({ "x-real-ip": "not-an-ip" }),
  h({ "cf-connecting-ip": CLIENT }),
  h({}),
];

let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("TRUSTED_CLIENT_IP_ENABLED", "");
  vi.stubEnv("TRUSTED_PROXY_HOPS", "");
  __resetForwardedShapeSample();
  info = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("isTrustedClientIpEnabled", () => {
  it('is on only for exactly "true"', () => {
    expect(isTrustedClientIpEnabled()).toBe(false);
    for (const value of ["TRUE", "True", "1", "yes", " true", "false"]) {
      vi.stubEnv("TRUSTED_CLIENT_IP_ENABLED", value);
      expect(isTrustedClientIpEnabled()).toBe(false);
    }
    vi.stubEnv("TRUSTED_CLIENT_IP_ENABLED", "true");
    expect(isTrustedClientIpEnabled()).toBe(true);
  });
});

describe("trustedProxyHops", () => {
  it("reads a whole number from 0 to 5", () => {
    for (const [value, hops] of [["0", 0], ["1", 1], ["3", 3], ["5", 5], [" 4 ", 4], ["05", 5]] as const) {
      vi.stubEnv("TRUSTED_PROXY_HOPS", value);
      expect(trustedProxyHops()).toBe(hops);
    }
  });

  it("falls back to 2 when empty or invalid", () => {
    expect(DEFAULT_TRUSTED_PROXY_HOPS).toBe(2);
    for (const value of ["", "  ", "6", "10", "-1", "2.5", "1e1", "two", "0x2", "999"]) {
      vi.stubEnv("TRUSTED_PROXY_HOPS", value);
      expect(trustedProxyHops()).toBe(2);
    }
    delete process.env.TRUSTED_PROXY_HOPS;
    expect(trustedProxyHops()).toBe(2);
  });
});

describe("clientIp, switch off", () => {
  it("matches the old rule exactly for every shape, whatever TRUSTED_PROXY_HOPS says", () => {
    for (const hops of ["", "0", "1", "2", "3", "5", "junk"]) {
      vi.stubEnv("TRUSTED_PROXY_HOPS", hops);
      for (const headers of SHAPES) expect(clientIp(headers)).toBe(legacyClientIp(headers));
    }
  });

  it("takes the first valid X-Forwarded-For entry, then x-real-ip, else unknown", () => {
    expect(clientIp(xff(`${CLIENT}, ${LB}, ${GFE}`))).toBe(CLIENT);
    expect(clientIp(xff(`${SPOOFED}, ${CLIENT}, ${LB}, ${GFE}`))).toBe(SPOOFED);
    expect(clientIp(xff(`junk, ${CLIENT}`))).toBe(CLIENT);
    expect(clientIp(xff(`${SPOOFED6}, ${CLIENT6}`))).toBe(SPOOFED6);
    expect(clientIp(xff("junk", { "x-real-ip": CLIENT }))).toBe(CLIENT);
    expect(clientIp(h({ "x-real-ip": ` ${CLIENT} ` }))).toBe(CLIENT);
    expect(clientIp(xff("not-an-ip-xyz"))).toBe("unknown");
    expect(clientIp(xff(""))).toBe("unknown");
    expect(clientIp(h({}))).toBe("unknown");
  });

  it("is what the old import path still returns", () => {
    expect(clientIpFromViewIngest).toBe(clientIp);
    expect(isIpLiteralFromViewIngest).toBe(isIpLiteral);
  });
});

describe("clientIp, switch on", () => {
  beforeEach(() => vi.stubEnv("TRUSTED_CLIENT_IP_ENABLED", "true"));

  it("reads App Hosting's shape: the visitor, the load balancer, the front end", () => {
    expect(clientIp(xff(`${CLIENT}, ${LB}, ${GFE}`))).toBe(CLIENT);
    expect(clientIp(xff(`${SPOOFED},${CLIENT},${LB},${GFE}`))).toBe(CLIENT);
  });

  it("ignores whatever a visitor writes at the start", () => {
    expect(clientIp(xff(`${SPOOFED}, ${CLIENT}, ${LB}, ${GFE}`))).toBe(CLIENT);
    expect(clientIp(xff(`not-an-ip, ${CLIENT}, ${LB}, ${GFE}`))).toBe(CLIENT);
    expect(clientIp(xff(`${SPOOFED},, ${CLIENT}, ${LB}, ${GFE}`))).toBe(CLIENT);
    expect(clientIp(xff(`1.1.1.1, 2.2.2.2, 3.3.3.3, ${CLIENT}, ${LB}, ${GFE}`))).toBe(CLIENT);
    // x-real-ip is only the fallback, never preferred over the trusted entry.
    expect(clientIp(xff(`${SPOOFED}, ${CLIENT}, ${LB}, ${GFE}`, { "x-real-ip": SPOOFED }))).toBe(CLIENT);
  });

  it("keys an IPv6 visitor on their /64, since they can send from any address in it", () => {
    const key = "2001:db8:0:0::/64";
    expect(clientIp(xff(`${CLIENT6}, ${LB}, ${GFE}`))).toBe(key);
    expect(clientIp(xff(`${SPOOFED6}, ${CLIENT6}, ${LB}, ${GFE}`))).toBe(key);
    expect(clientIp(xff(`${SPOOFED}, ${CLIENT6}, ${LB}, ${GFE}`))).toBe(key);
    // Two addresses in the same /64 share one bucket; another /64 gets its own.
    expect(clientIp(xff(`2001:db8:1:2::a1, ${LB}, ${GFE}`))).toBe(clientIp(xff(`2001:db8:1:2:ffff::a2, ${LB}, ${GFE}`)));
    expect(clientIp(xff(`2001:db8:1:3::a1, ${LB}, ${GFE}`))).not.toBe(clientIp(xff(`2001:db8:1:2::a1, ${LB}, ${GFE}`)));
  });

  it("keys an IPv4 address written as IPv6 as that IPv4 address", () => {
    expect(clientIp(xff(`::ffff:${CLIENT}, ${LB}, ${GFE}`))).toBe(CLIENT);
    expect(visitorKey("::ffff:203.0.113.7")).toBe(CLIENT);
    expect(visitorKey(CLIENT)).toBe(CLIENT);
  });

  it("uses the old rule when there are too few entries", () => {
    expect(clientIp(xff(`${CLIENT}, ${GFE}`))).toBe(CLIENT);
    expect(clientIp(xff(GFE))).toBe(GFE);
    expect(clientIp(xff(`junk, ${GFE}`))).toBe(GFE);
    expect(clientIp(xff("junk", { "x-real-ip": CLIENT }))).toBe(CLIENT);
  });

  it("uses the old rule when the trusted entry isn't an address", () => {
    expect(clientIp(xff(`${SPOOFED}, junk, ${LB}, ${GFE}`))).toBe(SPOOFED);
    expect(clientIp(xff(` , ${LB}, ${GFE}`))).toBe(LB);
    expect(clientIp(xff("junk, also junk, more junk"))).toBe("unknown");
    expect(clientIp(xff("junk, also junk, more junk", { "x-real-ip": CLIENT }))).toBe(CLIENT);
  });

  it("handles an empty or missing header like the old rule", () => {
    expect(clientIp(xff(""))).toBe("unknown");
    expect(clientIp(xff(",,,"))).toBe("unknown");
    expect(clientIp(xff("", { "x-real-ip": CLIENT }))).toBe(CLIENT);
    expect(clientIp(h({ "x-real-ip": CLIENT }))).toBe(CLIENT);
    expect(clientIp(h({}))).toBe("unknown");
  });

  it("counts TRUSTED_PROXY_HOPS entries from the right", () => {
    const header = xff("10.0.0.1, 10.0.0.2, 10.0.0.3, 10.0.0.4, 10.0.0.5, 10.0.0.6");
    for (const [hops, ip] of [["0", "10.0.0.6"], ["1", "10.0.0.5"], ["2", "10.0.0.4"], ["3", "10.0.0.3"], ["5", "10.0.0.1"]] as const) {
      vi.stubEnv("TRUSTED_PROXY_HOPS", hops);
      expect(clientIp(header)).toBe(ip);
    }
    vi.stubEnv("TRUSTED_PROXY_HOPS", "9"); // invalid: the default, 2
    expect(clientIp(header)).toBe("10.0.0.4");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "5");
    expect(clientIp(xff(`${CLIENT}, ${LB}, ${GFE}`))).toBe(CLIENT); // too few: the old rule
  });
});

describe("addressKind", () => {
  it("names private, Google front end and other ranges", () => {
    const cases: Array<[string, string]> = [
      ["10.1.2.3", "private"],
      ["172.16.0.1", "private"],
      ["172.31.255.255", "private"],
      ["172.32.0.1", "other"],
      ["172.15.0.1", "other"],
      ["192.168.1.1", "private"],
      ["127.0.0.1", "private"],
      ["169.254.169.254", "private"],
      ["35.191.0.1", "gfe"],
      ["35.191.255.255", "gfe"],
      ["35.190.0.1", "other"],
      ["35.192.0.1", "other"],
      ["130.211.0.1", "gfe"],
      ["130.211.3.255", "gfe"],
      ["130.211.4.0", "other"],
      [CLIENT, "other"],
      ["::1", "private"],
      ["0:0:0:0:0:0:0:1", "private"],
      ["fe80::1", "private"],
      ["FEBF::1", "private"],
      ["fec0::1", "other"],
      ["fc00::1", "private"],
      ["fd12:3456::1", "private"],
      ["fe00::1", "other"],
      [CLIENT6, "other"],
      ["::ffff:10.0.0.1", "private"],
      ["::ffff:35.191.1.1", "gfe"],
      ["::ffff:a00:1", "private"],
      ["::ffff:203.0.113.7", "other"],
      ["::", "other"],
      ["junk", "invalid"],
      ["", "invalid"],
      ["999.1.1.1", "invalid"],
      [":::", "invalid"],
      ["1::2::3", "invalid"],
      ["1:2:3:4:5:6:7:8:9", "invalid"],
      ["12345::1", "invalid"],
      ["::ffff:999.1.1.1", "invalid"],
    ];
    for (const [entry, kind] of cases) expect([entry, addressKind(entry)]).toEqual([entry, kind]);
  });
});

/** The one JSON line logged since the last check, parsed. */
function loggedSamples(): Array<{ line: string; sample: Record<string, unknown> }> {
  return info.mock.calls.map((call: unknown[]) => {
    const line = String(call[0]);
    return { line, sample: JSON.parse(line) as Record<string, unknown> };
  });
}

describe("the shape sample", () => {
  it("logs counts and kinds as structured JSON", () => {
    clientIp(xff(`${SPOOFED}, ${CLIENT}, ${LB}, ${GFE}`, { "cf-connecting-ip": CLIENT }));
    const samples = loggedSamples();
    expect(samples).toHaveLength(1);
    expect(samples[0]!.sample).toEqual({
      severity: "INFO",
      message: "forwarded_shape_sample",
      event: "forwarded_shape_sample",
      entries: 4,
      kinds: ["other", "other", "other", "gfe"],
      cfConnectingIp: true,
      cfFromRight: 2,
      xRealIp: false,
      hops: 2,
      hopKind: "other",
      trustedClientIp: false,
    });
  });

  it("never logs an address", () => {
    const sent = [CLIENT, SPOOFED, LB, GFE, CLIENT6, SPOOFED6, "10.0.0.1", "fd12:3456::1"];
    const shapes = [
      xff(`${SPOOFED}, ${CLIENT}, ${LB}, ${GFE}`, { "cf-connecting-ip": CLIENT, "x-real-ip": SPOOFED }),
      xff(`${SPOOFED6}, ${CLIENT6}, ${LB}, ${GFE}`, { "cf-connecting-ip": CLIENT6 }),
      xff(`10.0.0.1, fd12:3456::1, junk`, { "cf-connecting-ip": "10.0.0.1" }),
      xff(GFE, { "cf-connecting-ip": "not-an-ip" }),
    ];
    for (const on of ["", "true"]) {
      vi.stubEnv("TRUSTED_CLIENT_IP_ENABLED", on);
      for (const headers of shapes) {
        __resetForwardedShapeSample();
        clientIp(headers);
      }
    }
    const samples = loggedSamples();
    expect(samples).toHaveLength(shapes.length * 2);
    for (const { line, sample } of samples) {
      for (const address of sent) expect(line).not.toContain(address);
      expect(line).not.toMatch(/\d\.\d/); // no IPv4
      expect(line).not.toMatch(/[0-9a-f]:/i); // no IPv6: in this JSON every colon follows a quote
      expect(line).not.toContain("junk");
      for (const value of Object.values(sample)) {
        if (typeof value === "string") {
          expect(["INFO", "forwarded_shape_sample", "private", "gfe", "other", "invalid", "missing"]).toContain(value);
        }
      }
    }
  });

  it("logs at most once every 10 minutes per instance", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const headers = xff(`${CLIENT}, ${LB}, ${GFE}`);
    clientIp(headers);
    clientIp(headers);
    now.mockReturnValue(1_000_000 + SHAPE_SAMPLE_EVERY_MS - 1);
    clientIp(headers);
    expect(info).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_000_000 + SHAPE_SAMPLE_EVERY_MS);
    clientIp(headers);
    expect(info).toHaveBeenCalledTimes(2);
    expect(SHAPE_SAMPLE_EVERY_MS).toBe(10 * 60_000);
  });

  it("samples only requests that carry X-Forwarded-For", () => {
    clientIp(h({ "x-real-ip": CLIENT }));
    clientIp(xff(""));
    clientIp(h({}));
    expect(info).not.toHaveBeenCalled();
    clientIp(xff(`${CLIENT}, ${LB}, ${GFE}`));
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("says whether the switch is on, and the hops it read", () => {
    vi.stubEnv("TRUSTED_CLIENT_IP_ENABLED", "true");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    clientIp(xff(`${CLIENT}, ${GFE}`, { "x-real-ip": CLIENT }));
    expect(loggedSamples()[0]!.sample).toMatchObject({ trustedClientIp: true, hops: 1, hopKind: "other", xRealIp: true });
  });

  it("reports a missing trusted entry, and CF-Connecting-IP with no match", () => {
    const sample = forwardedShape(xff(GFE, { "cf-connecting-ip": CLIENT }), GFE, 2, false);
    expect(sample).toMatchObject({ entries: 1, kinds: ["gfe"], hopKind: "missing", cfConnectingIp: true, cfFromRight: null });
    const noCf = forwardedShape(xff(`${CLIENT}, ${LB}`), `${CLIENT}, ${LB}`, 0, true);
    expect(noCf).toMatchObject({ cfConnectingIp: false, cfFromRight: null, hopKind: "other", trustedClientIp: true });
  });

  it("matches CF-Connecting-IP from the right, ignoring case and spaces", () => {
    const header = `${CLIENT6.toUpperCase()}, ${LB}, ${GFE}`;
    expect(forwardedShape(xff(header, { "cf-connecting-ip": ` ${CLIENT6} ` }), header, 2, false).cfFromRight).toBe(2);
    const twice = `${CLIENT}, ${CLIENT}, ${GFE}`;
    expect(forwardedShape(xff(twice, { "cf-connecting-ip": CLIENT }), twice, 2, false).cfFromRight).toBe(1);
  });

  it("keeps the kinds list short on a long header", () => {
    const header = [...Array.from({ length: 30 }, (_, i) => `198.51.100.${i}`), LB, GFE].join(", ");
    clientIp(xff(header));
    const { sample } = loggedSamples()[0]!;
    expect(sample.entries).toBe(32);
    expect(sample.kinds).toHaveLength(MAX_SAMPLED_KINDS);
    expect((sample.kinds as string[]).at(-1)).toBe("gfe");
  });

  it("never fails a request when logging fails", () => {
    info.mockImplementation(() => {
      throw new Error("log sink down");
    });
    expect(clientIp(xff(`${SPOOFED}, ${CLIENT}, ${LB}, ${GFE}`))).toBe(SPOOFED);
    vi.stubEnv("TRUSTED_CLIENT_IP_ENABLED", "true");
    __resetForwardedShapeSample();
    expect(clientIp(xff(`${SPOOFED}, ${CLIENT}, ${LB}, ${GFE}`))).toBe(CLIENT);
  });
});
