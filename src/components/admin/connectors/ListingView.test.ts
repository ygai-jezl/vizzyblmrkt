import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { SIGNIN_REASONS } from "@/lib/connectors/messages";
import { connectionView, listingFor, textOf } from "./testing";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));
const { ListingView } = await import("./ListingView");
const { listingBanner } = await import("./listingBanner");
const { LISTING_COPY, limitsOf, readsOf, replaceableOf, signInReasonWords, waitingShareOf, youNeedOf } = await import("./words");

type Props = Parameters<typeof ListingView>[0];
const CF = listingFor("cloudflare", ["token_fields"]);
const SC = listingFor("search-console", ["oauth_pkce", "share_access"]);
const GA = listingFor("google-analytics", ["oauth_pkce", "share_access"]);
const html = (p: Partial<Props> & Pick<Props, "listing">) =>
  renderToStaticMarkup(createElement(ListingView, { connections: [], isAdmin: true, chat: false, banner: null, replace: null, ...p }));

const SHARED = connectionView({
  id: "dcn_shshshshshshshshshsh",
  connectorId: "search-console",
  connectorName: "Google Search Console",
  needsAccount: true,
  canReadLive: false,
  health: { state: "check", lastOkAt: null, lastCheckedAt: null, message: null, pausedUntil: null },
  details: { method: "share_access", account: "", secrets: [], serviceAccount: { email: "ygc-made-up-address@connect.example.iam.gserviceaccount.com", deletedAt: null } },
});

describe("the Cloudflare Listing", () => {
  it("asks for the manifest's fields, with its steps and the filled in token link", () => {
    const out = html({ listing: CF });
    const text = textOf(out);
    expect(text).toContain("Connect with an API token");
    expect(out).toContain('id="field-zoneId"');
    expect(out).toMatch(/id="field-token"[^>]*type="password"|type="password"[^>]*id="field-token"/);
    expect(text).toContain("Give the token one permission: Zone, Analytics, Read.");
    expect(out).toContain('href="https://dash.cloudflare.com/profile/api-tokens?');
    expect(text).toContain("Open Cloudflare with the form filled in");
    expect(text).toContain(LISTING_COPY.tokenCheck);
    expect(text).not.toContain("Sign in with Google");
    expect(text).not.toContain("Choose how to connect");
  });

  it("never lets the browser put the token in an address, even before the page's script runs", () => {
    const out = html({ listing: CF });
    const form = /<form\b[^>]*>[\s\S]*?<\/form>/.exec(out)?.[0] ?? "";
    expect(form).toMatch(/^<form\b[^>]*\bmethod="post"/);
    // No field has a name, so a form sent without the script carries nothing.
    expect(form).toContain('id="field-token"');
    expect(form).not.toMatch(/<input\b[^>]*\bname=/);
    // Connect stays off until the script is running.
    expect(form).toMatch(/<button type="submit"[^>]*\bdisabled=""/);
  });

  it("says what it reads and never does, every number's meaning and the lag, from the manifest", () => {
    const text = textOf(html({ listing: CF }));
    expect(text).toContain("From Cloudflare What In YouGrow Daily totals for the zone requests, page views and visits Read live when you or Vizzy ask. Nothing is stored.");
    expect(text).toContain("Nothing is ever written to Cloudflare.");
    expect(text).toContain("Cloudflare requests");
    expect(text).toContain("A day's numbers are complete the next day.");
    expect(text).toContain(CF.disconnect);
    expect(text).toContain("a token with this permission: Zone, Analytics, Read.");
    expect(html({ listing: CF })).toContain('href="/help/connected-data#cloudflare"');
  });

  it("explains a reconnect and fills in the zone of the connection it replaces", () => {
    const broken = connectionView({ health: { state: "broken", lastOkAt: null, lastCheckedAt: null, message: "x", pausedUntil: null } });
    const out = html({ listing: CF, connections: [broken], replace: broken });
    expect(textOf(out)).toContain(LISTING_COPY.tokenReconnect);
    expect(out).toContain('value="0123456789abcdef0123456789abcdef"');
  });
});

describe("the Search Console and Google Analytics Listings", () => {
  it("put Sign in with Google first, marked Quickest, then share access", () => {
    for (const listing of [SC, GA]) {
      const text = textOf(html({ listing }));
      expect(text, listing.id).toContain("Choose how to connect Sign in with Google Quickest");
      expect(text.indexOf("Sign in with Google")).toBeLessThan(text.indexOf("Or share access"));
      expect(text).toContain(`YouGrow asks only to read your ${listing.name} data.`);
      expect(text).toContain(LISTING_COPY.shareStart);
      expect(text).toContain(LISTING_COPY.googleLimit);
    }
  });

  it("offer only share access when Sign in isn't ready here, as for GA4 before Google's review", () => {
    const text = textOf(html({ listing: listingFor("google-analytics", ["share_access"]) }));
    expect(text).not.toContain("Sign in with Google");
    expect(text).not.toContain("Choose how to connect");
    expect(text).toContain("Share access Give a Google address made for this connection");
    expect(text).not.toContain(LISTING_COPY.googleLimit);
  });

  it("shows a waiting shared connection's address, the manifest's steps and Check access", () => {
    const out = html({ listing: SC, connections: [SHARED] });
    const text = textOf(out);
    expect(text).toContain("Copy this address. ygc-made-up-address@connect.example.iam.gserviceaccount.com Copy");
    expect(text).toContain("Press Add user, paste the address YouGrow shows, choose Restricted, then press Add.");
    expect(text).toContain("Check access");
    expect(text).not.toContain(LISTING_COPY.shareStart);
    const ga = textOf(html({ listing: GA, connections: [{ ...SHARED, connectorId: "google-analytics" }] }));
    expect(ga).toContain("Property access management");
    expect(ga).toContain("choose the Viewer role");
  });

  it("reads the property table from each manifest", () => {
    expect(textOf(html({ listing: GA }))).toContain("Traffic numbers for the property you pick");
    expect(textOf(html({ listing: SC }))).toContain("Search numbers for the site you pick");
    expect(textOf(html({ listing: SC }))).toContain("A day's numbers are complete about 3 days later.");
  });
});

describe("for members and after a sign in", () => {
  it("shows a member the same page with nothing to press", () => {
    for (const listing of [CF, SC]) {
      const out = html({ listing, isAdmin: false, connections: [SHARED] });
      expect(textOf(out), listing.id).toContain(LISTING_COPY.adminsOnly);
      expect(out).not.toContain("<button");
      expect(out).not.toContain("<input");
      expect(out).not.toContain("gserviceaccount");
    }
  });

  it("says why a sign in didn't finish in the callback's words, or that it connected", () => {
    expect(listingBanner({ status: "error", reason: "wrong_browser", reconnected: false })).toEqual({ tone: "err", text: SIGNIN_REASONS.wrong_browser });
    expect(listingBanner({ status: "error", reason: "made_up", reconnected: false })?.text).toBe(LISTING_COPY.signInFallback);
    expect(listingBanner({ status: "connected", reason: null, reconnected: true })?.text).toBe(LISTING_COPY.reconnectedBanner);
    expect(listingBanner({ status: null, reason: null, reconnected: false })).toBeNull();
    expect(textOf(html({ listing: SC, banner: { tone: "err", text: SIGNIN_REASONS.denied } }))).toContain(SIGNIN_REASONS.denied);
    expect(signInReasonWords("toString")).toBe(LISTING_COPY.signInFallback);
  });
});

describe("the Listing's words", () => {
  it("name what each way to connect needs, and Google's limit only with Sign in", () => {
    expect(youNeedOf(SC)).toBe("Access to the site or property in Google Search Console. To share access, someone who can add users to it.");
    expect(youNeedOf(listingFor("search-console", ["oauth_pkce"]))).toBe("A Google account that can see the site or property in Google Search Console.");
    expect(limitsOf(CF, true)).toEqual(["Vizzy reads up to 93 days and 100 rows at a time."]);
    expect(limitsOf(SC, false)).toEqual(["Each read covers up to 93 days and 100 rows.", LISTING_COPY.googleLimit]);
    expect(readsOf(CF).never).toEqual(["Nothing is ever written to Cloudflare."]);
  });

  it("find the waiting shared connection and the one a reconnect replaces", () => {
    expect(waitingShareOf([SHARED], "search-console")?.id).toBe(SHARED.id);
    expect(waitingShareOf([{ ...SHARED, needsAccount: false }], "search-console")).toBeNull();
    const broken = connectionView({ health: { state: "broken", lastOkAt: null, lastCheckedAt: null, message: null, pausedUntil: null } });
    expect(replaceableOf([broken], "cloudflare", broken.id)?.id).toBe(broken.id);
    expect(replaceableOf([connectionView()], "cloudflare", broken.id)).toBeNull();
    expect(replaceableOf([broken], "search-console", broken.id)).toBeNull();
    expect(replaceableOf([broken], "cloudflare", null)).toBeNull();
  });

  it("write in house style", () => {
    for (const line of Object.values(LISTING_COPY)) {
      expect(dashesIn(line), line).toEqual([]);
      expect(aiTellsIn(line), line).toEqual([]);
    }
    for (const listing of [CF, SC, GA]) for (const l of [youNeedOf(listing), ...limitsOf(listing, true)]) expect(dashesIn(l)).toEqual([]);
  });
});

describe("the Listing as people read it", () => {
  it("writes in house style in every state, admin or member", () => {
    const broken = connectionView({ health: { state: "broken", lastOkAt: null, lastCheckedAt: null, message: "x", pausedUntil: null } });
    const pages = [
      html({ listing: CF }),
      html({ listing: CF, connections: [broken], replace: broken }),
      html({ listing: SC, connections: [SHARED] }),
      html({ listing: GA }),
      html({ listing: SC, isAdmin: false }),
      html({ listing: SC, banner: { tone: "ok", text: LISTING_COPY.connectedBanner } }),
    ];
    for (const page of pages) {
      const text = textOf(page);
      expect(dashesIn(text), text.slice(0, 80)).toEqual([]);
      expect(aiTellsIn(text), text.slice(0, 80)).toEqual([]);
    }
  });
});
