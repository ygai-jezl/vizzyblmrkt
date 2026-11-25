import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import type { SharedConnectionsScreen, SharedConnectionView } from "@/lib/connectors/organisationConnect";
import type { OrganisationAccount } from "@/lib/connectors/organisationParts";
import { textOf } from "./testing";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/admin/account/organisation" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));
const { SharedCard, SharedConnectionsView } = await import("./SharedConnectionsView");
const { GiveForm } = await import("./GivePartDialog");
const W = await import("./words");

// Settings › Organisation › Shared connections, as the approved screens draw it, for Fernhill
// Group [made up]: Fernhill Plants and Harbour Blooms in Europe, Fernhill US in the United States,
// Priya its owner. Every name, site and number here is made up.
const NOW = new Date("2026-11-24T12:00:00.000Z");
const T = "2026-11-12T09:00:00.000Z";
const BRANDS: SharedConnectionsScreen["brands"] = [
  { id: "ten_fernhill", name: "Fernhill Plants", region: "eu", regionName: "Europe", rootDomain: "fernhill.example", isThis: true, isAdmin: true },
  { id: "ten_harbour", name: "Harbour Blooms", region: "eu", regionName: "Europe", rootDomain: "harbourblooms.example", isThis: false, isAdmin: true },
  { id: "ten_fernhill-us", name: "Fernhill US", region: "us", regionName: "United States", rootDomain: "fernhill-us.example", isThis: false, isAdmin: true },
];
const collect = (over: Record<string, unknown> = {}) => ({
  lastDay: "2026-11-23",
  finalThrough: null,
  keptFrom: "2026-08-26",
  days: 90,
  keepDays: 90,
  filled: true,
  timeZone: "UTC",
  lag: "",
  keeps: "",
  kept: null,
  waitingFor: null,
  failedSince: null,
  failedOn: null,
  holdReason: null,
  feedsPlanning: false,
  ...over,
});
const ok = { state: "ok" as const, lastErrorCode: null, since: null, lastCheckedAt: T };
type Part = SharedConnectionView["parts"][number];
const part = (tenantId: string, account: string, over: Partial<Part> = {}, rec: Partial<NonNullable<Part["record"]>> = {}): Part => {
  const b = BRANDS.find((x) => x.id === tenantId)!;
  return {
    tenantId,
    brandName: b.name,
    region: b.region,
    regionName: b.regionName,
    account,
    state: "active",
    givenAt: T,
    stateSince: T,
    record: {
      status: "connected",
      label: "Cloudflare",
      health: ok,
      grants: [
        { to: "members", can: "read" },
        { to: "agent:vizzy", can: "read" },
      ],
      pausedAt: null,
      collect: collect() as never,
      ...rec,
    },
    ...over,
  };
};
const conn = (over: Partial<SharedConnectionView> = {}): SharedConnectionView => ({
  id: "ocn_aaaaaaaaaaaaaaaaaaaa",
  connectorId: "cloudflare",
  connectorName: "Cloudflare",
  connectorOn: true,
  method: "token_fields",
  label: "Cloudflare",
  region: "eu",
  regionName: "Europe",
  signer: null,
  mine: true,
  health: ok,
  pausedAt: null,
  pausedByYou: false,
  collectHold: null,
  serviceAccount: null,
  parts: [part("ten_fernhill", "0123456789abcdef0123456789abcd01", {}, { label: "fernhill.example" }), part("ten_fernhill-us", "0123456789abcdef0123456789abcd02", {}, { label: "fernhill-us.example" })],
  stoppedUsing: null,
  hadParts: true,
  createdAt: T,
  ...over,
});
const screen = (connections: SharedConnectionView[], over: Partial<SharedConnectionsScreen> = {}): SharedConnectionsScreen => ({
  organisation: { id: "org_ten_fernhill", name: "Fernhill Group" },
  brand: { id: "ten_fernhill", name: "Fernhill Plants", region: "eu", regionName: "Europe" },
  connections,
  brands: BRANDS,
  revoke: false,
  chat: true,
  collect: true,
  ...over,
});
const noop = () => {};
const actions = { give: noop, change: noop, takeBack: noop, pause: noop, signInAgain: noop, disconnect: noop, copy: noop };
// The card's title is the name, bold, then how it signs in: one line on screen, two nodes here.
const flat = (html: string) => textOf(html).replace(/ ([,.])/g, "$1");
const card = (c: SharedConnectionView, s = screen([c])) => renderToStaticMarkup(SharedCard({ c, screen: s, now: NOW, actions, busy: false, copied: false, after: null }) as never);
const GA = (over: Partial<SharedConnectionView> = {}) =>
  conn({
    id: "ocn_gggggggggggggggggggg",
    connectorId: "google-analytics",
    connectorName: "Google Analytics 4",
    method: "oauth_pkce",
    signer: "you",
    parts: [
      part("ten_fernhill", "properties/24680135", {}, { label: "Fernhill Plants web", collect: collect({ finalThrough: "2026-11-21" }) as never }),
      part("ten_fernhill-us", "properties/13579246", {}, { label: "Fernhill US web", collect: collect({ finalThrough: "2026-11-21" }) as never, grants: [] }),
    ],
    ...over,
  });
const SC = (over: Partial<SharedConnectionView> = {}) =>
  conn({
    id: "ocn_ssssssssssssssssssss",
    connectorId: "search-console",
    connectorName: "Google Search Console",
    method: "share_access",
    serviceAccount: { email: "ygc-made-up-address@connect.example.iam.gserviceaccount.com" },
    parts: [part("ten_fernhill", "sc-domain:fernhill.example"), part("ten_harbour", "sc-domain:harbourblooms.example", {}, { collect: collect({ filled: false, days: 34 }) as never, grants: [{ to: "members", can: "read" }] })],
    ...over,
  });

describe("a shared connection's card", () => {
  it("names how it signs in and where it is kept, and lists who gets which part, with a brand's region only when it differs", () => {
    const text = textOf(card(conn()));
    expect(flat(card(conn()))).toContain("Cloudflare, API token. Kept in Europe. Working");
    expect(text).toContain("Part Given to Since Collected Readers Actions");
    expect(text).toContain("fernhill.example Fernhill Plants 12 Nov To 23 Nov, 90 days Admins, members, Vizzy");
    expect(text).toContain("fernhill-us.example Fernhill US United States 12 Nov To 23 Nov, 90 days");
    expect(text).not.toContain("Fernhill Plants Europe");
    // Not every brand has a zone: Harbour Blooms can still be given one.
    expect(text).toContain("Give a brand a zone");
  });

  it("gives way to a hint once every brand has a part", () => {
    const all = conn({ parts: [...conn().parts, part("ten_harbour", "0123456789abcdef0123456789abcd03", {}, { label: "harbourblooms.example" })] });
    const text = textOf(card(all));
    expect(text).toContain("Each brand has a zone from this token.");
    expect(text).not.toContain("Give a brand a zone");
  });

  it("shows a Google address made for the organisation, with Copy, and a site still filling", () => {
    const text = textOf(card(SC()));
    expect(flat(card(SC()))).toContain("Search Console, a Google address made for Fernhill Group. Kept in Europe. Working");
    expect(text).toContain("Google address ygc-made-up-address@connect.example.iam.gserviceaccount.com Copy");
    expect(text).toContain("sc-domain:harbourblooms.example Harbour Blooms 12 Nov Filling: 34 of 90 days Admins, members");
  });

  it("says a GA4 property's name and its final days, and asks for a part when it has none", () => {
    expect(flat(card(GA()))).toContain("Google Analytics 4, signed in with Google by you. Kept in Europe. Working");
    expect(textOf(card(GA()))).toContain("Property 24680135 (Fernhill Plants web) Fernhill Plants 12 Nov To 23 Nov (final to 21 Nov) Admins, members, Vizzy");
    expect(textOf(card(GA({ parts: [], hadParts: false })))).toContain("Nothing is collected until you give a brand a property.");
  });

  it("for another owner's sign in, says so without a name and keeps Give and Change for the signer", () => {
    const out = card(GA({ signer: "other", mine: false }));
    expect(flat(out)).toContain("Google Analytics 4, signed in with Google by another owner.");
    expect(textOf(out)).toContain("Only the owner who signed in can give its properties. You can take one back, pause, disconnect, or sign in again yourself.");
    expect(out).toMatch(/<button type="button"[^>]*disabled=""[^>]*>Give a brand a property<\/button>/);
    expect(out).toMatch(/disabled=""[^>]*aria-label="Change Fernhill US&#x27;s property"/);
    expect(out).not.toMatch(/disabled=""[^>]*aria-label="Take back from Fernhill US"/);
  });

  it("warns when the signer is no longer an owner, and puts Sign in again first", () => {
    const out = card(GA({ signer: "gone", mine: false }));
    expect(flat(out)).toContain("Google Analytics 4, signed in with Google. Kept in Europe.");
    expect(textOf(out)).toContain("Signed in by someone who is no longer an owner. Sign in again to keep giving properties.");
    expect(out).toMatch(/<button type="button" class="[^"]*bg-neutral-900[^"]*">Sign in again<\/button>/);
  });

  it("says when Google ended the sign in, for both brands, and stops each row there", () => {
    const broken = { state: "broken" as const, lastErrorCode: "signin_refused", since: "2026-11-21T03:00:00.000Z", lastCheckedAt: "2026-11-21T03:00:00.000Z" };
    const text = textOf(card(GA({ health: broken, parts: GA().parts.map((p) => ({ ...p, record: { ...p.record!, collect: collect({ lastDay: "2026-11-20" }) as never } })) })));
    expect(text).toContain("Needs attention");
    expect(text).toContain("Google ended this sign-in on 21 Nov. Both brands stopped collecting. Sign in again to fix it for both.");
    expect(text).toContain("Stopped on 21 Nov Collected to 20 Nov");
  });

  it("counts a part its brand can't read, on that row only", () => {
    const lost = SC({
      parts: [SC().parts[0]!, { ...SC().parts[1]!, record: { ...SC().parts[1]!.record!, health: { state: "broken", lastErrorCode: "share_access_lost", since: "2026-11-22T06:00:00.000Z", lastCheckedAt: "2026-11-22T06:00:00.000Z" } } }],
    });
    const text = textOf(card(lost));
    expect(text).toContain("Working 1 brand can't read its part");
    expect(text).toContain("sc-domain:harbourblooms.example Harbour Blooms 12 Nov Can't read since 22 Nov. Add the address to sc-domain:harbourblooms.example again.");
    expect(text).toContain("sc-domain:fernhill.example Fernhill Plants 12 Nov To 23 Nov, 90 days");
  });

  it("says a quota hold pauses collecting only, and a pause by an owner stops reading too", () => {
    expect(textOf(card(conn({ collectHold: { until: "2026-11-24T14:05:00.000Z", reason: "quota" } })))).toContain(
      "Collecting paused until 14:05 UTC because Cloudflare's limit was reached. Live reads go on.",
    );
    const paused = textOf(card(conn({ pausedAt: "2026-11-20T08:00:00.000Z", pausedByYou: true })));
    expect(paused).toContain("Kept in Europe. Paused");
    expect(paused).toContain("Paused on 20 Nov by you. No brand reads it live or collects it. Numbers already collected stay readable.");
    expect(paused).toContain("Paused on 20 Nov Collected to 23 Nov");
    expect(paused).toContain("Resume");
  });

  it("says who stopped using it, and offers to disconnect once no brand uses it", () => {
    const text = textOf(card(GA({ parts: [], stoppedUsing: { brandName: "Fernhill US", at: "2026-11-24T09:00:00.000Z" } })));
    expect(text).toContain("Fernhill US stopped using it on 24 Nov.");
    expect(text).toContain("No brand uses this any more. Disconnect it?");
    expect(text).not.toContain("Nothing is collected until");
  });

  it("dates a changed part from its change, and offers no Change for a brand that left", () => {
    const changed = conn({ parts: [part("ten_fernhill", "0123456789abcdef0123456789abcd01", { givenAt: "2026-11-12T09:00:00.000Z", stateSince: "2026-11-24T09:00:00.000Z" })] });
    const text = textOf(card(changed));
    expect(text).toContain("24 Nov");
    expect(text).not.toContain("12 Nov");
    // A part whose brand is no longer listed (it left, and housekeeping hasn't ended it yet): Take back only.
    const gone = conn({ parts: [part("ten_fernhill", "0123456789abcdef0123456789abcd01", { tenantId: "ten_gone", brandName: "A brand that left" })] });
    const buttons = [...card(gone).matchAll(/<button([^>]*)>/g)].map((m) => m[1]!);
    expect(buttons.find((b) => b.includes('aria-label="Change A brand that left'))).toContain('disabled=""');
    expect(buttons.find((b) => b.includes('aria-label="Take back from A brand that left"'))).not.toContain('disabled=""');
  });

  it("says Sign in again fixes it, with no dangling words, however many brands it serves", () => {
    const g = { method: "oauth_pkce" as const, connectorName: "Google Analytics 4", health: { lastErrorCode: "signin_refused", since: "2026-11-21T06:00:00.000Z", lastCheckedAt: T } };
    expect(W.sharedBrokenWords(g, 0)).toBe("Google ended this sign-in on 21 Nov. Sign in again to fix it.");
    expect(W.sharedBrokenWords(g, 1)).toBe("Google ended this sign-in on 21 Nov. Its brand stopped collecting. Sign in again to fix it.");
    expect(W.sharedBrokenWords(g, 2)).toBe("Google ended this sign-in on 21 Nov. Both brands stopped collecting. Sign in again to fix it for both.");
    expect(W.sharedBrokenWords(g, 3)).toBe("Google ended this sign-in on 21 Nov. All 3 brands stopped collecting. Sign in again to fix it for all of them.");
  });

  it("hides the Collected column while numbers aren't collected", () => {
    expect(textOf(card(conn(), screen([conn()], { collect: false })))).toContain("Part Given to Since Readers Actions");
  });

  it("reads Vizzy as a reader only while Vizzy reads connected data", () => {
    expect(textOf(card(conn(), screen([conn()], { chat: false })))).toContain("fernhill.example Fernhill Plants 12 Nov To 23 Nov, 90 days Admins, members");
    expect(textOf(card(conn(), screen([conn()], { chat: false })))).not.toContain("Vizzy");
  });
});

describe("the Shared connections section", () => {
  it("says why a sign in for the organisation didn't finish, here where the owner pressed it", () => {
    const text = textOf(renderToStaticMarkup(createElement(SharedConnectionsView, { screen: screen([]), back: { status: "error", connection: null, reason: "denied" }, now: NOW.toISOString() })));
    expect(text).toContain("Access wasn't given on Google's screen, so nothing was connected.");
  });

  it("leads with what it does, says how a connect came back, and points nowhere new when nothing is shared", () => {
    const text = textOf(renderToStaticMarkup(createElement(SharedConnectionsView, { screen: screen([]), back: { status: "connected", connection: null }, now: NOW.toISOString() })));
    expect(text).toContain("Shared connections Connect once for the organisation, then give each brand its own site, property or zone. Each brand's team sees only its own.");
    expect(text).toContain("Connected for Fernhill Group. Give each brand its part below.");
    expect(text).toContain("Nothing is shared yet.");
  });
});

describe("giving a brand a part", () => {
  const SC_SIGNED = SC({ method: "oauth_pkce", signer: "you", serviceAccount: null, parts: [part("ten_fernhill", "sc-domain:fernhill.example")] });
  const accounts: OrganisationAccount[] = [
    { id: "sc-domain:fernhill.example", label: "fernhill.example (whole domain)", detail: null, givenTo: { tenantId: "ten_fernhill" }, givenElsewhere: null, ownCount: 0, ownAdminBrandIds: [] },
    { id: "sc-domain:harbourblooms.example", label: "harbourblooms.example (whole domain)", detail: null, givenTo: null, givenElsewhere: null, ownCount: 0, ownAdminBrandIds: [] },
    { id: "https://shop.fernhill.example/", label: "https://shop.fernhill.example/", detail: null, givenTo: null, givenElsewhere: null, ownCount: 0, ownAdminBrandIds: [] },
    { id: "sc-domain:fernhill-us.example", label: "fernhill-us.example (whole domain)", detail: null, givenTo: null, givenElsewhere: null, ownCount: 1, ownAdminBrandIds: ["ten_fernhill"] },
  ];
  const form = (over: Partial<Parameters<typeof GiveForm>[0]> = {}) =>
    textOf(
      renderToStaticMarkup(
        createElement(GiveForm, {
          c: SC_SIGNED,
          screen: screen([SC_SIGNED]),
          mode: "give",
          brandId: "ten_harbour",
          partId: "sc-domain:harbourblooms.example",
          accounts,
          loadError: null,
          members: true,
          vizzy: false,
          busy: false,
          error: null,
          onBrand: noop,
          onPart: noop,
          onMembers: noop,
          onVizzy: noop,
          ...over,
        }),
      ),
    );

  it("offers the brands with a part greyed, a brand in another region with its note, and the list only the signer sees", () => {
    const text = form();
    expect(text).toContain("Brand Fernhill Plants Has sc-domain:fernhill.example Harbour Blooms Fernhill US Fernhill US keeps its numbers in the United States. The sign in stays in Europe.");
    expect(text).toContain("Site Only you see this list.");
    expect(text).toContain("sc-domain:fernhill.example Given to Fernhill Plants");
    expect(text).toContain("https://shop.fernhill.example/ Inside sc-domain:fernhill.example, which Fernhill Plants has. Both brands would see these pages.");
    expect(text).toContain("Readers for Harbour Blooms Choose who can read it. Admins always can. Members can read it Vizzy can read it when someone asks");
    expect(text).toContain("Your Google account reads this site for Harbour Blooms. Harbour Blooms' team sees only this site.");
  });

  it("warns, without naming it, when another brand reads a site with its own connection, and marks a site not on the brand's own", () => {
    const text = form();
    expect(text).toContain("sc-domain:fernhill-us.example Another brand in Fernhill Group already reads this site with its own connection.");
    // A brand you don't run reads it: counted, never named, and still warned about.
    const unnamed = accounts.map((a) => (a.id === "sc-domain:fernhill-us.example" ? { ...a, ownAdminBrandIds: [] } : a));
    expect(form({ accounts: unnamed })).toContain("sc-domain:fernhill-us.example Another brand in Fernhill Group already reads this site with its own connection.");
    // The brand it would go to is the only one reading it itself: no warning about another brand.
    expect(textOf(renderToStaticMarkup(createElement(GiveForm, { ...formProps(), brandId: "ten_fernhill" })))).not.toContain("Another brand in Fernhill Group already reads this site");
    expect(textOf(renderToStaticMarkup(createElement(GiveForm, { ...formProps(), brandId: "ten_fernhill-us" })))).toContain("sc-domain:harbourblooms.example Not on fernhill-us.example.");
  });

  it("greys a brand the owner isn't an admin of", () => {
    const notAdmin = screen([SC_SIGNED], { brands: BRANDS.map((b) => (b.id === "ten_harbour" ? { ...b, isAdmin: false } : b)) });
    const out = renderToStaticMarkup(createElement(GiveForm, { ...formProps(), screen: notAdmin, brandId: "ten_fernhill-us" }));
    expect(textOf(out)).toContain("Harbour Blooms You're not an admin of Harbour Blooms.");
    // Greyed in the hint colour, as the approved dialog draws it, never a fade that leaves the note hard to read.
    expect(out).not.toContain("opacity-60");
  });

  it("shows no list to an owner who didn't sign in", () => {
    const text = form({ c: { ...SC_SIGNED, signer: "other", mine: false } });
    expect(text).toContain("Only the owner who signed in can give its sites to more brands. You can take one back, pause, disconnect, or sign in again yourself.");
    expect(text).not.toContain("Only you see this list.");
    expect(text).not.toContain("Readers for");
  });

  it("says what changing a part deletes and refills", () => {
    const text = form({ mode: "change", brandId: "ten_fernhill", partId: "sc-domain:fernhill.example" });
    expect(text).toContain("Fernhill Plants' numbers from sc-domain:fernhill.example are deleted, and 90 days fill again from the new site within a day.");
    expect(text).not.toContain("Readers for");
  });

  function formProps() {
    return {
      c: SC_SIGNED,
      screen: screen([SC_SIGNED]),
      mode: "give" as const,
      brandId: "ten_harbour",
      partId: null,
      accounts,
      loadError: null,
      members: true,
      vizzy: false,
      busy: false,
      error: null,
      onBrand: noop,
      onPart: noop,
      onMembers: noop,
      onVizzy: noop,
    };
  }
});

describe("the confirm dialogs' words", () => {
  it("say what each erases, refills or rechecks, as the approved screens write them", () => {
    expect(W.takeBackTextWords("Harbour Blooms", "site", "share_access", "Google Search Console")).toBe(
      "Harbour Blooms stops reading this site now. What YouGrow collected for it is deleted, with its suggestions. YouGrow's address can still read the site: remove it in Search Console if no brand uses it.",
    );
    expect(W.disconnectTextWords(2)).toBe("2 brands stop reading it now, and what YouGrow collected for them is deleted.");
    expect(W.disconnectTextWords(1)).toBe("1 brand stops reading it now, and what YouGrow collected for it is deleted.");
    expect(W.signInAgainTextWords([{ brand: "Fernhill Plants", part: "Property 24680135" }, { brand: "Fernhill US", part: "Property 13579246" }])).toBe(
      "This sign-in serves 2 brands: Fernhill Plants reads Property 24680135 and Fernhill US reads Property 13579246. Signing in again uses your Google account for both, and makes you the one who signed in.",
    );
    expect(W.afterSignInWords("Property 13579246", "Fernhill US")).toBe(
      "Your Google account can't read Property 13579246, so Fernhill US stops reading it until someone who can signs in again, or an owner takes it back.",
    );
    expect(W.disconnectTitleWords("Google Search Console", "Fernhill Group")).toBe("Disconnect Google Search Console for Fernhill Group");
  });
});

describe("Shared connections in house style", () => {
  it("uses no dashes as punctuation and none of the AI tells, in every state and dialog", () => {
    const pages = [
      card(conn()),
      card(SC()),
      card(GA({ signer: "other", mine: false })),
      card(GA({ signer: "gone", mine: false })),
      card(GA({ parts: [], hadParts: false })),
      card(GA({ parts: [], stoppedUsing: { brandName: "Fernhill US", at: "2026-11-24T09:00:00.000Z" } })),
      card(conn({ pausedAt: "2026-11-20T08:00:00.000Z", pausedByYou: false, collectHold: { until: "2026-11-24T14:05:00.000Z", reason: "quota" } })),
    ].map(textOf);
    const lines = [
      ...pages,
      ...Object.values(W.SHARED_COPY),
      ...Object.values(W.GIVE_COPY),
      W.REVOKE_WARNING,
      W.signedInAgainWords(1),
      W.signedInAgainWords(0),
      W.sharedBrokenWords({ method: "token_fields", connectorName: "Cloudflare", health: { lastErrorCode: "token_refused", since: T, lastCheckedAt: T } }, 3),
      W.sharedBrokenWords({ method: "share_access", connectorName: "Google Search Console", health: { lastErrorCode: "share_access_lost", since: T, lastCheckedAt: T } }, 1),
      W.cantReadWords("oauth_pkce", "properties/1", "Google Analytics 4", T).hint,
      W.cantReadWords("token_fields", "z", "Cloudflare", T).hint,
    ];
    for (const line of lines) {
      expect(dashesIn(line), line.slice(0, 80)).toEqual([]);
      expect(aiTellsIn(line), line.slice(0, 80)).toEqual([]);
    }
  });
});
