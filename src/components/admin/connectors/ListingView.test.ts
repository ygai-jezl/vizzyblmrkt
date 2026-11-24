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
const { ConnectFor, ListingView, TypedWhy } = await import("./ListingView");
const { listingBanner } = await import("./listingBanner");
const { CONNECT_FOR_COPY, LISTING_COPY, chosenAtFirst, limitsOf, moreListedWords, readsOf, replaceableOf, signInReasonWords, tokenCheckedWords, typedWhyWords, waitingShareOf, youNeedOf } = await import("./words");
const { checkPastedToken, secretsOf } = await import("./tokenConnect");

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
  it("asks for the token first, with its steps and the filled in token link, and Check before Connect", () => {
    const out = html({ listing: CF });
    const text = textOf(out);
    expect(text).toContain("Connect with an API token");
    expect(text).toContain("Built by YouGrow · Website and traffic · Ready");
    // Its tile is Cloudflare's cloud, an image with no words beside the name; CF without it.
    expect(text).toMatch(/^Cloudflare Built by YouGrow /);
    expect(out).toMatch(/^<div[^>]*><div[^>]*><span aria-hidden="true"[^>]*><img src="\/marks\/connectors\/cloudflare\/icon\.png" alt=""/);
    expect(textOf(html({ listing: { ...CF, icon: undefined } }))).toMatch(/^CF Cloudflare /);
    expect(out).toMatch(/id="field-token"[^>]*type="password"|type="password"[^>]*id="field-token"/);
    // The zone comes after Check: picked from what the token can see, or typed when it can't list.
    expect(out).not.toContain('id="field-zoneId"');
    expect(text).toContain("Give the token three permissions: Zone Read, so YouGrow can list your zones; Zone Analytics Read, so it can read their numbers; and Account Analytics Read, asked for now so later features don't need a new token. Nothing reads with it today.");
    expect(text).toContain("Paste the token here and press Check.");
    expect(out).toContain('href="https://dash.cloudflare.com/profile/api-tokens?');
    expect(text).toContain("Open Cloudflare with the form filled in");
    expect(text).toContain(LISTING_COPY.checkFirst);
    expect(out).toMatch(/<button type="submit"[^>]*>Check<\/button>/);
    expect(text).not.toContain("Connect Cancel");
    expect(text).not.toContain("Sign in with Google");
    expect(text).not.toContain("Choose how to connect");
  });

  it("fills in Zone Read, Zone Analytics Read and Account Analytics Read on Cloudflare's token form", () => {
    const link = decodeURIComponent(CF.connect[0]!.method === "token_fields" ? (CF.connect[0]!.tokenLink ?? "") : "");
    // Keys from Cloudflare's token template docs: zone, analytics (the zone's) and account_analytics.
    expect(JSON.parse(new URL(link).searchParams.get("permissionGroupKeys")!)).toEqual([
      { key: "zone", type: "read" },
      { key: "analytics", type: "read" },
      { key: "account_analytics", type: "read" },
    ]);
    expect(CF.connect[0]!.method === "token_fields" && CF.connect[0]!.permissions).toEqual(["Zone Read", "Zone Analytics Read", "Account Analytics Read"]);
    expect(textOf(html({ listing: CF }))).toContain("Under Account Resources, include only the account your site is in.");
    expect(link).toMatch(/^https:\/\/dash\.cloudflare\.com\/profile\/api-tokens\?/);
  });

  it("puts its one way to connect straight under the name, with no heading level skipped", () => {
    const out = html({ listing: CF });
    expect(out).toMatch(/<h3 id="connect-token"[^>]*>Connect with an API token<\/h3>/);
    expect(out).not.toMatch(/<h4 id="connect-/);
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
    expect(text).toContain("From Cloudflare What In YouGrow Daily totals for the zone requests, page views, visits and unique visitors Read live when you or Vizzy ask.");
    // Nothing about keeping numbers while collected numbers are off.
    expect(text).not.toContain("kept 90 days");
    expect(text).toContain("Your zones their names Listed when you press Check, so you can pick one. Not stored.");
    // Account Analytics Read has its own line, which says nothing reads with it today.
    expect(text).toContain("Your account's analytics Asked for now so later features don't need a new token. Nothing is read with it today.");
    expect(text).toContain("Nothing is ever written to Cloudflare.");
    expect(text).toContain("Cloudflare requests");
    expect(text).toContain("A day's numbers are final the next day.");
    expect(text).toContain(CF.disconnect);
    expect(text).toContain("a token with these permissions: Zone Read, Zone Analytics Read and Account Analytics Read.");
    expect(html({ listing: CF })).toContain('href="/help/connected-data#cloudflare"');
  });

  it("says each day is kept 90 days in the brand's region only while collected numbers are on", () => {
    vi.stubEnv("CONNECTORS_ENABLED", "true");
    vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "true");
    try {
      const text = textOf(html({ listing: listingFor("cloudflare", ["token_fields"]) }));
      expect(text).toContain("A day's numbers are final the next day. Collected once a day and kept 90 days in your brand's region; Disconnect deletes them.");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("explains a reconnect, and starts on the zone of the connection it replaces once the token is checked", () => {
    const broken = connectionView({ health: { state: "broken", lastOkAt: null, lastCheckedAt: null, message: "x", pausedUntil: null } });
    const out = html({ listing: CF, connections: [broken], replace: broken });
    expect(textOf(out)).toContain(LISTING_COPY.tokenReconnect);
    const zones = [
      { id: "0123456789abcdef0123456789abcdef", label: "acme.example" },
      { id: "fedcba9876543210fedcba9876543210", label: "shop.acme.example" },
    ];
    expect(chosenAtFirst(zones, broken.details!.account)).toBe("0123456789abcdef0123456789abcdef");
    // A token Listing that doesn't pick from a list asks for every field at once, the account filled in.
    const typed = { ...CF, connect: CF.connect.map((c) => (c.method === "token_fields" ? { ...c, pick: undefined } : c)) };
    const all = html({ listing: typed, connections: [broken], replace: broken });
    expect(all).toContain('id="field-zoneId"');
    expect(all).toContain('value="0123456789abcdef0123456789abcdef"');
    expect(textOf(all)).toContain(LISTING_COPY.tokenCheck);
  });
});

describe("Check on the Cloudflare Listing", () => {
  const zones = [
    { id: "0123456789abcdef0123456789abcdef", label: "acme.example", detail: null },
    { id: "fedcba9876543210fedcba9876543210", label: "shop.acme.example", detail: "Not active in Cloudflare yet" },
  ];
  const stub = (answer: { ok: true; data: unknown } | { ok: false; status: number; error: string; message: string }) => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const call = (async (url: string, init?: { body?: unknown }) => {
      calls.push({ url, body: init?.body });
      return answer;
    }) as Parameters<typeof checkPastedToken>[2];
    return { call, calls };
  };

  it("sends only the token to the check route, and lists what it can see to pick from", async () => {
    const { call, calls } = stub({ ok: true, data: { accounts: zones, more: false, listed: true } });
    expect(await checkPastedToken("cloudflare", { token: "made-up-token-000000000000" }, call)).toEqual({ kind: "listed", accounts: zones, more: false });
    expect(calls).toEqual([{ url: "/api/admin/connectors/cloudflare/check", body: { fields: { token: "made-up-token-000000000000" } } }]);
  });

  it("falls back to a typed Zone ID when the token can't list zones, and says why it was turned down", async () => {
    expect(await checkPastedToken("cloudflare", { token: "x" }, stub({ ok: true, data: { accounts: [], more: false, listed: false } }).call)).toEqual({ kind: "typed" });
    const refused = stub({ ok: false, status: 502, error: "token_refused", message: "Cloudflare turned the token down." });
    expect(await checkPastedToken("cloudflare", { token: "x" }, refused.call)).toEqual({ kind: "refused", message: "Cloudflare turned the token down." });
  });

  it("drops an answer for a token edited while Check ran, so the new one is never shown as checked", async () => {
    const method = CF.connect[0]!;
    const fields = method.method === "token_fields" ? method.fields : [];
    const form = { token: "made-up-token-000000000000", zoneId: "" };
    const sent = secretsOf(fields, form);
    expect(sent).toEqual({ token: "made-up-token-000000000000" });
    // The admin types over the token before the answer listing the old token's zones comes back.
    const late = (async () => {
      form.token = "made-up-token-111111111111";
      return { ok: true, data: { accounts: zones, more: false, listed: true } };
    }) as Parameters<typeof checkPastedToken>[2];
    expect(await checkPastedToken("cloudflare", sent, late, () => secretsOf(fields, form))).toEqual({ kind: "stale" });
    // A turned down answer for the old token is dropped too, and an unchanged token keeps its answer.
    const refusedLate = (async () => ({ ok: false, status: 502, error: "token_refused", message: "Cloudflare turned the token down." })) as Parameters<typeof checkPastedToken>[2];
    expect(await checkPastedToken("cloudflare", sent, refusedLate, () => secretsOf(fields, form))).toEqual({ kind: "stale" });
    const same = stub({ ok: true, data: { accounts: zones, more: false, listed: true } });
    expect(await checkPastedToken("cloudflare", sent, same.call, () => sent)).toEqual({ kind: "listed", accounts: zones, more: false });
  });

  it("names the zone chosen, and starts on the only one", () => {
    expect(tokenCheckedWords(zones, zones[0]!.id)).toBe("Token checked: it can see acme.example. Nothing is saved until you press Connect.");
    expect(tokenCheckedWords(zones, "")).toBe(LISTING_COPY.checkedChoose);
    expect(chosenAtFirst([zones[0]!], null)).toBe(zones[0]!.id);
    expect(chosenAtFirst(zones, null)).toBe("");
    expect(chosenAtFirst(zones, "0000000000000000000000000000dead")).toBe("");
    expect(moreListedWords("Cloudflare", "Zone ID")).toBe("Cloudflare listed more than fit here. If yours isn't in the list, type its Zone ID instead.");
  });

  it("gives each way to a typed Zone ID its own words, never that the token can't list zones after it listed more than fit", () => {
    const method = CF.connect[0]!;
    if (method.method !== "token_fields" || !method.pick) throw new Error("Cloudflare picks its zone from a list");
    const zone = method.fields.find((f) => f.key === method.account)!;
    // The field's own hint says only where to find it, so it fits however it came to be typed.
    expect(zone.help).toBe("Find it on your site's Overview page in Cloudflare, in the API box on the right.");
    // The token can't list zones: the manifest's note, as a warning, with no list to go back to.
    expect(typedWhyWords("Cloudflare", zone.label, method.pick, false)).toBe(method.pick.cantList);
    const cant = renderToStaticMarkup(createElement(TypedWhy, { text: method.pick.cantList, listed: false, onPick: () => {} }));
    expect(textOf(cant)).toBe(method.pick.cantList);
    expect(cant).not.toContain(LISTING_COPY.pickFromList);
    // It listed zones, but more than fit, and the admin pressed Type the Zone ID: words for that, and the way back.
    const more = typedWhyWords("Cloudflare", zone.label, method.pick, true);
    expect(more).toBe("Cloudflare listed more than fit here, so type the Zone ID of the one you want.");
    const listed = textOf(renderToStaticMarkup(createElement(TypedWhy, { text: more, listed: true, onPick: () => {} })));
    expect(listed).toBe(`${more} ${LISTING_COPY.pickFromList}`);
    for (const line of [zone.help!, listed]) {
      expect(line).not.toMatch(/can't list|Only when/);
      expect(dashesIn(line), line).toEqual([]);
      expect(aiTellsIn(line), line).toEqual([]);
    }
  });

  it("says why the zone is typed in the manifest's own words", () => {
    const method = CF.connect[0]!;
    expect(method.method === "token_fields" && method.pick).toEqual({
      label: "Zone",
      cantList: "This token can't list your zones (that needs Zone Read), so type your site's Zone ID instead.",
    });
  });
});

describe("the Search Console and Google Analytics Listings", () => {
  it("put Sign in with Google first, marked Quickest, then share access", () => {
    for (const listing of [SC, GA]) {
      const text = textOf(html({ listing }));
      expect(text, listing.id).toContain("Choose how to connect Sign in with Google Quickest");
      expect(text, listing.id).toContain("Built by YouGrow · Search and analytics · Ready");
      expect(text.indexOf("Sign in with Google")).toBeLessThan(text.indexOf("Or share access"));
      expect(text).toContain(`YouGrow asks only to read your ${listing.name} data.`);
      expect(text).toContain(LISTING_COPY.shareStart);
      expect(text).toContain(LISTING_COPY.googleLimit);
      // Two ways: each card's title sits under "Choose how to connect".
      const out = html({ listing });
      expect(out).toMatch(/<h3[^>]*>Choose how to connect<\/h3>/);
      expect(out).toMatch(/<h4 id="connect-sign-in"/);
      expect(out).toMatch(/<h4 id="connect-share"/);
    }
  });

  it("offer only share access when Sign in isn't ready here, as for GA4 before Google's review", () => {
    const text = textOf(html({ listing: listingFor("google-analytics", ["share_access"]) }));
    expect(text).not.toContain("Sign in with Google");
    expect(text).not.toContain("Choose how to connect");
    expect(text).toContain("Share access Give a Google address made for this connection");
    expect(html({ listing: listingFor("google-analytics", ["share_access"]) })).toMatch(/<h3 id="connect-share"/);
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

  it("signs in with Google's own button, light or dark with the theme, named Sign in with Google", () => {
    for (const listing of [SC, GA]) {
      const out = html({ listing });
      const button = out.match(/<button type="button" class="[^"]*">((?:(?!<\/button>).)*)<\/button>/)!;
      expect(button, listing.id).toBeTruthy();
      expect(button[1]).toBe(
        '<img src="/marks/google/signin-light.png" alt="Sign in with Google" width="180" height="40" class="block dark:hidden"/>' +
          '<img src="/marks/google/signin-dark.png" alt="Sign in with Google" width="180" height="40" class="hidden dark:block"/>',
      );
      // Nothing is shown as busy until it is pressed.
      expect(textOf(out)).not.toContain(LISTING_COPY.openingGoogle);
    }
    expect(html({ listing: CF })).not.toContain("/marks/google/");
    expect(html({ listing: SC, isAdmin: false })).not.toContain("/marks/google/");
  });

  it("shows Google Analytics' own logo, linked to Google Analytics, at least 154 by 50, only on its Listing", () => {
    const out = html({ listing: GA });
    const text = textOf(out);
    expect(text).toContain(`${LISTING_COPY.dataFrom} (opens in a new tab)`);
    const link = out.match(/<a href="([^"]+)" target="_blank" rel="noopener noreferrer"[^>]*>((?:(?!<\/a>).)*)<\/a>/)!;
    expect(link[1]).toBe("https://analytics.google.com/");
    expect(link[2]).toContain('<img src="/marks/connectors/google-analytics/lockup-light.png" alt="Google Analytics" width="189" height="50" class="dark:hidden"/>');
    expect(link[2]).toContain('<img src="/marks/connectors/google-analytics/lockup-dark.png" alt="Google Analytics" width="189" height="50" class="hidden dark:block"/>');
    // In the What it reads card, after the numbers, so it is never the biggest thing on the page.
    const reads = out.slice(out.indexOf('id="connector-reads"'));
    expect(reads.indexOf("lockup-light.png")).toBeGreaterThan(reads.indexOf(LISTING_COPY.numbersTitle));
    expect(reads.indexOf("lockup-light.png")).toBeLessThan(reads.indexOf("</section>"));
    for (const listing of [SC, CF]) expect(html({ listing }), listing.id).not.toContain("lockup");
  });

  it("reads the property table from each manifest", () => {
    expect(textOf(html({ listing: GA }))).toContain("Traffic numbers for the property you pick");
    expect(textOf(html({ listing: SC }))).toContain("Search numbers for the site you pick");
    expect(textOf(html({ listing: SC }))).toContain("A day's numbers are final about 3 days later.");
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

describe("Connect for, for an owner of the brand's organisation (Connectors 3)", () => {
  const ORG = { id: "org_ten_fernhill", name: "Fernhill Group", brandName: "Harbour Blooms", regionName: "Europe", shareable: true, waitingShare: null };

  it("offers this brand or the organisation above the ways to connect, this brand chosen first", () => {
    const out = html({ listing: SC, organisation: ORG });
    const text = textOf(out);
    expect(text).toContain("Connect for This brand (Harbour Blooms) Fernhill Group (all its brands) Choose how to connect");
    expect(out).toMatch(/<input type="radio" name="connect-for"[^>]*checked=""[^>]*value="brand"/);
    // Until the organisation is chosen, nothing says where it is kept, and the consent line waits.
    expect(text).not.toContain("Kept in Europe");
    expect(text).not.toContain("Only you see the list");
  });

  it("says where the organisation's sign in is kept once it is chosen", () => {
    const text = textOf(renderToStaticMarkup(createElement(ConnectFor, { brand: "Harbour Blooms", org: ORG, forOrg: true, onChange: () => {} })));
    expect(text).toContain("Fernhill Group (all its brands) Kept in Europe, where Harbour Blooms keeps its data. Each brand's numbers stay in its own region.");
    expect(CONNECT_FOR_COPY.consent("YouGrow.AI", "site")).toBe(
      "You can give each brand in YouGrow.AI one site this Google account can see. Only you see the list. Each brand's team sees only its own site, and the other owners see which brand has which.",
    );
  });

  it("is not offered to a member, without an organisation, or for a connector that can't be shared", () => {
    expect(textOf(html({ listing: SC, organisation: ORG, isAdmin: false }))).not.toContain("Connect for");
    expect(textOf(html({ listing: SC }))).not.toContain("Connect for");
    expect(textOf(html({ listing: SC, organisation: { ...ORG, shareable: false } }))).not.toContain("Connect for");
  });

  it("writes its words in house style", () => {
    const lines = [
      CONNECT_FOR_COPY.consent("Fernhill Group", "property"),
      CONNECT_FOR_COPY.keptIn("Europe", "Harbour Blooms"),
      CONNECT_FOR_COPY.tokenHint("Fernhill Group"),
      CONNECT_FOR_COPY.checkedGoOn,
      textOf(html({ listing: CF, organisation: ORG })),
    ];
    for (const line of lines) {
      expect(dashesIn(line), line).toEqual([]);
      expect(aiTellsIn(line), line).toEqual([]);
    }
  });
});
