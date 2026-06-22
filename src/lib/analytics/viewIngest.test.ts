import { describe, it, expect } from "vitest";
import {
  ViewBeaconSchema,
  classifyUa,
  referrerHost,
  buildWidgetViewRow,
  clientIp,
  isIpLiteral,
  rateLimitExceeded,
  fixedWindowExceeded,
  recallCampaignExists,
  rememberCampaignExists,
} from "./viewIngest";

describe("ViewBeaconSchema", () => {
  it("rejects unknown fields (strict) and a missing campaignId", () => {
    expect(ViewBeaconSchema.safeParse({ campaignId: "c1", evil: 1 }).success).toBe(false);
    expect(ViewBeaconSchema.safeParse({ t: "x" }).success).toBe(false);
    expect(ViewBeaconSchema.safeParse({ campaignId: "c1" }).success).toBe(true);
  });

  it("rejects unknown utm sub-fields (strict)", () => {
    expect(
      ViewBeaconSchema.safeParse({ campaignId: "c1", utm: { source: "x", junk: 1 } }).success,
    ).toBe(false);
  });
});

describe("classifyUa", () => {
  it("treats crawlers, unfurlers, HTTP libs and a missing UA as bots", () => {
    expect(classifyUa(undefined)).toBe("bot");
    expect(classifyUa("")).toBe("bot");
    expect(classifyUa("Googlebot/2.1 (+http://www.google.com/bot.html)")).toBe("bot");
    expect(classifyUa("facebookexternalhit/1.1")).toBe("bot");
    expect(classifyUa("python-requests/2.31")).toBe("bot");
    expect(classifyUa("curl/8.4.0")).toBe("bot");
  });
  it("recognises a real browser", () => {
    expect(
      classifyUa(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      ),
    ).toBe("browser");
  });
  it("treats an unrecognised agent as unknown", () => {
    expect(classifyUa("SomeRandomAgent/1.0")).toBe("unknown");
  });
});

describe("referrerHost", () => {
  it("reduces a URL to its lowercase host — no path, query, or PII", () => {
    expect(referrerHost("https://News.YCombinator.com/item?id=1&user=alice")).toBe(
      "news.ycombinator.com",
    );
  });
  it("returns null for empty/invalid input", () => {
    expect(referrerHost(undefined)).toBeNull();
    expect(referrerHost("")).toBeNull();
    expect(referrerHost("not a url")).toBeNull();
  });
});

describe("buildWidgetViewRow", () => {
  const browser = new Headers({ "user-agent": "Mozilla/5.0 Chrome/120 Safari/537.36" });
  const input = ViewBeaconSchema.parse({
    campaignId: "c1",
    t: "ten_ATTACKER", // a body-supplied tenant must NEVER become identity
    ref: "https://blog.example.com/some/post?secret=1",
    utm: { source: "twitter", medium: "cpc" },
  });

  it("builds a PII-free row keyed to the SERVER tenant/campaign", () => {
    const row = buildWidgetViewRow(input, browser, "ten_REAL", "c1");
    expect(row.tenant_id).toBe("ten_REAL"); // not input.t
    expect(row.campaign_id).toBe("c1");
    expect(row.referrer_host).toBe("blog.example.com"); // host only, no path/query
    expect(row.utm_source).toBe("twitter");
    expect(row.utm_medium).toBe("cpc");
    expect(row.utm_term).toBeNull();
    expect(row.ua_class).toBe("browser");
    expect(row.is_bot).toBe(false);
    expect(row.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(row.ingest_day).toBe(row.event_ts.slice(0, 10));
    // The schema carries NO IP / email / cookie / raw-UA / full-URL field.
    const keys = Object.keys(row);
    for (const banned of ["ip", "email", "cookie", "user_agent", "ua", "referrer_url"]) {
      expect(keys).not.toContain(banned);
    }
  });

  it("flags an unrecognised agent as a bot in the row", () => {
    const row = buildWidgetViewRow(input, new Headers({ "user-agent": "weird/1" }), "t", "c1");
    expect(row.ua_class).toBe("unknown");
    expect(row.is_bot).toBe(true);
  });
});

describe("clientIp / isIpLiteral", () => {
  it("returns the first VALID ip literal and folds spoofed junk to one bucket", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" }))).toBe("9.9.9.9");
    expect(clientIp(new Headers({ "x-real-ip": "8.8.8.8" }))).toBe("8.8.8.8");
    expect(clientIp(new Headers())).toBe("unknown");
    // Non-IP garbage (per-request randomised to mint fresh buckets) → "unknown".
    expect(clientIp(new Headers({ "x-forwarded-for": "not-an-ip-xyz" }))).toBe("unknown");
    // Skips a junk first hop and uses the first valid literal.
    expect(clientIp(new Headers({ "x-forwarded-for": "junk, 1.2.3.4" }))).toBe("1.2.3.4");
  });
  it("validates IPv4/IPv6 literals", () => {
    expect(isIpLiteral("1.2.3.4")).toBe(true);
    expect(isIpLiteral("999.1.1.1")).toBe(false);
    expect(isIpLiteral("2001:db8::1")).toBe(true);
    expect(isIpLiteral("hello")).toBe(false);
  });
});

describe("rateLimitExceeded / fixedWindowExceeded", () => {
  it("allows up to the cap, then drops, then resets after the window", () => {
    const key = `1.2.3.4:t:c-${Math.random()}`;
    const t0 = 1_000_000;
    let dropped = 0;
    for (let i = 0; i < 35; i += 1) if (rateLimitExceeded(key, t0)) dropped += 1;
    expect(dropped).toBe(5); // 30 allowed, 5 over the per-minute cap
    // A new window resets the counter.
    expect(rateLimitExceeded(key, t0 + 61_000)).toBe(false);
  });

  it("honours a caller-supplied ceiling (coarse + miss budgets)", () => {
    const key = `miss:tenant-${Math.random()}`;
    const t0 = 2_000_000;
    let dropped = 0;
    for (let i = 0; i < 6; i += 1) if (fixedWindowExceeded(key, t0, 3)) dropped += 1;
    expect(dropped).toBe(3); // 3 allowed, 3 over
  });
});

describe("campaign existence cache", () => {
  it("recalls positive AND negative answers within the TTL, expires after", () => {
    const key = `t:camp-${Math.random()}`;
    const now = 5_000_000;
    expect(recallCampaignExists(key, now)).toBeUndefined();
    rememberCampaignExists(key, false, now); // negative cache (forged-id spam)
    expect(recallCampaignExists(key, now + 1000)).toBe(false);
    expect(recallCampaignExists(key, now + 6 * 60_000)).toBeUndefined(); // expired
  });
});
