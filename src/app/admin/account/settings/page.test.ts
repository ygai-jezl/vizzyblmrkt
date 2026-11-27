import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireAdminContext, getTenantById, listBusinessFacts, listConversations, openFactSuggestions, isLiveConfigured, readBrandPointers } = vi.hoisted(() => ({
  readBrandPointers: vi.fn(),
  requireAdminContext: vi.fn(),
  getTenantById: vi.fn(),
  listBusinessFacts: vi.fn(),
  listConversations: vi.fn(),
  openFactSuggestions: vi.fn(),
  isLiveConfigured: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ requireAdminContext }));
vi.mock("@/lib/tenant", () => ({ getTenantById }));
vi.mock("@/lib/onboarding/store", () => ({ listBusinessFacts, listConversations }));
vi.mock("@/lib/onboarding/factSuggestions", () => ({ openFactSuggestions }));
vi.mock("@/lib/agents/gemini", () => ({ isLiveConfigured }));
vi.mock("@/lib/tenant/loops", () => ({ readBrandPointers }));

const { default: AccountSettingsPage } = await import("./page");
const { SIGN_IN_SECURITY_COPY } = await import("@/components/admin/SignInSecurityCard");

const CTX = { tenantId: "ten_demo", region: "us" as const, userId: "uid_owner", role: "admin" as const, source: "idtoken" as const };

const SWITCHES = [
  "PASSWORD_SIGNIN_ENABLED",
  "NEXT_PUBLIC_NAV_V2_ENABLED",
  "NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED",
  "NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED",
  "NEXT_PUBLIC_SEARCH_ENABLED",
  "BRAND_SIGNALS_ENABLED",
];

function phase3On() {
  process.env.NEXT_PUBLIC_NAV_V2_ENABLED = "true";
  process.env.NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED = "true";
  process.env.NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED = "true";
}

async function renderPage(): Promise<string> {
  return renderToStaticMarkup((await AccountSettingsPage()) as ReactElement).replace(/&#x27;/g, "'");
}

describe("Settings › General, Sign-in and security", () => {
  beforeEach(() => {
    for (const name of SWITCHES) delete process.env[name];
    requireAdminContext.mockResolvedValue(CTX);
    getTenantById.mockResolvedValue({ tenantName: "Acme", rootDomain: "acme.example.com" });
    // Nothing kept: About your business stays away with its switch off.
    listBusinessFacts.mockResolvedValue([]);
    listConversations.mockResolvedValue([]);
  });
  afterEach(() => {
    for (const name of SWITCHES) delete process.env[name];
    vi.clearAllMocks();
  });

  it("has no card with the switch off, on either navigation", async () => {
    const legacy = await renderPage();
    expect(legacy).not.toContain(SIGN_IN_SECURITY_COPY.title);
    expect(legacy).not.toContain(SIGN_IN_SECURITY_COPY.signOutEverywhere);
    // Today's page: the languages card alone, with no wrapper.
    expect(legacy).not.toContain('class="space-y-6"');

    phase3On();
    const general = await renderPage();
    expect(general).toContain("Brand details");
    expect(general).not.toContain(SIGN_IN_SECURITY_COPY.title);
  });

  it("reads the switch as exactly \"true\"", async () => {
    for (const value of ["1", "TRUE", "yes", ""]) {
      process.env.PASSWORD_SIGNIN_ENABLED = value;
      expect(await renderPage(), value).not.toContain(SIGN_IN_SECURITY_COPY.title);
    }
  });

  it("shows the card under the languages with the switch on and the old navigation", async () => {
    process.env.PASSWORD_SIGNIN_ENABLED = "true";
    const html = await renderPage();
    expect(html).toContain(SIGN_IN_SECURITY_COPY.title);
    expect(html).toContain(SIGN_IN_SECURITY_COPY.signOutEverywhere);
    expect(html).toContain(SIGN_IN_SECURITY_COPY.devicesNote);
    // The languages card still renders first (its own loading line), then the new card.
    expect(html.indexOf("Loading…")).toBeLessThan(html.indexOf(SIGN_IN_SECURITY_COPY.title));
    expect(html).not.toContain("Brand details");
  });

  it("puts the card under Brand details in Settings › General, and leaves the rest as it was", async () => {
    process.env.PASSWORD_SIGNIN_ENABLED = "true";
    phase3On();
    const html = await renderPage();
    const details = html.indexOf("Brand details");
    const security = html.indexOf(SIGN_IN_SECURITY_COPY.title);
    expect(details).toBeGreaterThan(-1);
    expect(security).toBeGreaterThan(details);
    for (const text of ["Acme", "acme.example.com", "United States (can't be changed)", "ten_demo"]) {
      expect(html).toContain(text);
    }
    expect(getTenantById).toHaveBeenCalledWith("ten_demo");
  });
});

describe("Settings › General, About your business", () => {
  const ABOUT = [
    "ONBOARDING_ENABLED",
    "ONBOARDING_VOICE_ENABLED",
    "GRANTED_ONLY_FEATURES",
    "NEXT_PUBLIC_NAV_V2_ENABLED",
    "NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED",
    "NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED",
    "PASSWORD_SIGNIN_ENABLED",
  ];
  const thisYear = new Date().getUTCFullYear();
  const PROFILE = { status: "done", via: "questions", answers: { who: "solo", run: "shop", want: "audience" }, rev: 2, startedAt: `${thisYear}-11-25T09:00:00.000Z` };
  const FACT = {
    id: "bf_0123456789abcdef",
    tenantId: "ten_demo",
    kind: "channel",
    text: "Sells at three farmers' markets",
    quote: "We sell at three farmers' markets most weekends.",
    source: "voice",
    conversationId: `oc_${"a".repeat(32)}`,
    heardAt: `${thisYear}-11-25T10:00:00.000Z`,
    confirmedAt: `${thisYear}-11-25T10:06:00.000Z`,
    createdAt: `${thisYear}-11-25T10:06:00.000Z`,
  };
  const CALL = { id: `oc_${"a".repeat(32)}`, source: "voice", status: "ended", startedAt: `${thisYear}-11-25T10:00:00.000Z`, endedAt: `${thisYear}-11-25T10:04:12.000Z`, lengthSec: 252, turnCount: 9, waiting: false };

  const brand = (over: Record<string, unknown> = {}) => ({ tenantName: "Acme", rootDomain: "acme.example.com", ...over });

  beforeEach(() => {
    for (const name of ABOUT) delete process.env[name];
    requireAdminContext.mockResolvedValue(CTX);
    getTenantById.mockResolvedValue(brand({ businessProfile: PROFILE }));
    listBusinessFacts.mockResolvedValue([FACT]);
    listConversations.mockResolvedValue([CALL]);
    openFactSuggestions.mockResolvedValue([]);
    isLiveConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    for (const name of ABOUT) delete process.env[name];
    vi.clearAllMocks();
  });

  it("isn't there with the switch off, no profile and nothing kept", async () => {
    phase3On();
    getTenantById.mockResolvedValue(brand());
    listBusinessFacts.mockResolvedValue([]);
    listConversations.mockResolvedValue([]);
    const html = await renderPage();
    expect(html).toContain("Brand details");
    expect(html).not.toContain("About your business");
    // Nor when the lists can't be read: there would be nothing to read or delete.
    listBusinessFacts.mockRejectedValue(new Error("unavailable"));
    listConversations.mockRejectedValue(new Error("unavailable"));
    expect(await renderPage()).not.toContain("About your business");
    expect(openFactSuggestions).not.toHaveBeenCalled();
  });

  it("stays with the switch off and no profile while a call is kept, to read and delete it", async () => {
    phase3On();
    // A call talked from Settings, never confirmed: no profile was written.
    getTenantById.mockResolvedValue(brand());
    listBusinessFacts.mockResolvedValue([]);
    const html = await renderPage();
    expect(html).toContain("About your business");
    expect(html).toContain("Call with Vizzy");
    expect(html).toContain("View transcript");
    expect(html).toContain('aria-label="Delete the call on 25 Nov"');
    expect(html).not.toMatch(/aria-haspopup="menu"/);
    expect(html).not.toContain('href="/admin/welcome"');
    expect(html).toContain(">Nothing yet.<");

    listConversations.mockResolvedValue([]);
    listBusinessFacts.mockResolvedValue([FACT]);
    const facts = await renderPage();
    expect(facts).toContain("Sells at three farmers' markets");
    expect(facts).toContain(">Remove<");
  });

  it("comes first for an admin, above Brand details, with the answers, what Vizzy learned and the conversations", async () => {
    process.env.ONBOARDING_ENABLED = "true";
    process.env.PASSWORD_SIGNIN_ENABLED = "true";
    phase3On();
    const html = await renderPage();
    const order = [
      "About your business",
      "Vizzy reads this in every chat. Only your admins and Vizzy see it.",
      "The basics",
      "What Vizzy learned",
      "Conversations",
      "Brand details",
      SIGN_IN_SECURITY_COPY.title,
    ];
    const at = order.map((w) => html.indexOf(w));
    expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // The chips open their menus; an unanswered one reads Not picked.
    expect(html).toContain('aria-label="Who you are: A solo founder. Change"');
    expect(html).toContain('aria-label="Where it is today: not picked. Change"');
    expect(html).toMatch(/aria-haspopup="menu"/);
    expect(html).toContain("Sells at three farmers' markets");
    expect(html).toContain("From our call, 25 Nov");
    expect(html).toContain('aria-label="Conversations with Vizzy"');
    expect(html).toContain("Call with Vizzy");
    expect(html).toContain("4 min 12 s");
    expect(html).toContain('aria-label="View the transcript of the call on 25 Nov"');
    expect(html).toContain('aria-label="Delete the call on 25 Nov"');
    expect(html).toContain("Vizzy keeps the words, never the audio. Each one stays until you delete it.");
    expect(listBusinessFacts).toHaveBeenCalledWith(CTX);
    expect(listConversations).toHaveBeenCalledWith(CTX);
    expect(getTenantById).toHaveBeenCalledTimes(1);
  });

  it("isn't there for a member, who reads neither list", async () => {
    process.env.ONBOARDING_ENABLED = "true";
    phase3On();
    requireAdminContext.mockResolvedValue({ ...CTX, role: "member" });
    const html = await renderPage();
    expect(html).toContain("Brand details");
    expect(html).not.toContain("About your business");
    expect(listBusinessFacts).not.toHaveBeenCalled();
    requireAdminContext.mockResolvedValue({ ...CTX, role: undefined });
    expect(await renderPage()).not.toContain("About your business");
  });

  it("stays with the switch off while a profile exists, so kept words can be read and deleted, but nothing else changes", async () => {
    phase3On();
    const html = await renderPage();
    expect(html).toContain("About your business");
    expect(html).toContain("View transcript");
    expect(html).toContain(">Remove<");
    // The answers show without their menus (saving them needs the switch), and no Talk with Vizzy.
    expect(html).toContain("A solo founder");
    expect(html).not.toMatch(/aria-haspopup="menu"/);
    expect(html).not.toContain('href="/admin/welcome"');
  });

  it("links Talk with Vizzy again, as a plain link, once a call is kept, and Talk with Vizzy before", async () => {
    process.env.ONBOARDING_ENABLED = "true";
    process.env.ONBOARDING_VOICE_ENABLED = "true";
    phase3On();
    const again = await renderPage();
    expect(again).toMatch(/<a href="\/admin\/welcome"[^>]*>.*Talk with Vizzy again<\/a>/s);

    listConversations.mockResolvedValue([]);
    const first = await renderPage();
    expect(first).toMatch(/<a href="\/admin\/welcome"[^>]*>.*Talk with Vizzy<\/a>/s);
    expect(first).not.toContain("Talk with Vizzy again");
    expect(first).toContain("No conversations kept.");
  });

  it("hides Talk with Vizzy with voice off, without a Live key, or kept from this brand", async () => {
    process.env.ONBOARDING_ENABLED = "true";
    phase3On();
    expect(await renderPage()).not.toContain('href="/admin/welcome"');

    process.env.ONBOARDING_VOICE_ENABLED = "true";
    isLiveConfigured.mockReturnValue(false);
    expect(await renderPage()).not.toContain('href="/admin/welcome"');

    isLiveConfigured.mockReturnValue(true);
    process.env.GRANTED_ONLY_FEATURES = "onboarding_voice";
    expect(await renderPage()).not.toContain('href="/admin/welcome"');
    getTenantById.mockResolvedValue(brand({ businessProfile: PROFILE, grantedFeatures: ["onboarding_voice"] }));
    expect(await renderPage()).toContain('href="/admin/welcome"');
  });

  it("lists what Vizzy heard in a later chat, waiting for Keep, only while the switch is on", async () => {
    const WAITING = { id: `aa_${"c".repeat(40)}`, rev: 1, kind: "goal", text: "A hundred sign-ups by spring", quote: "We'd love a hundred sign-ups by the spring.", asked: "What would make this year a good one?", at: `${thisYear}-11-26T09:00:00.000Z` };
    openFactSuggestions.mockResolvedValue([WAITING]);
    process.env.ONBOARDING_ENABLED = "true";
    phase3On();
    const html = await renderPage();
    expect(html).toContain("From a chat, 26 Nov. Waiting for you");
    expect(html).toContain('aria-label="Keep A hundred sign-ups by spring"');
    // Vizzy's question is never sent to the browser.
    expect(html).not.toContain("What would make this year a good one?");

    delete process.env.ONBOARDING_ENABLED;
    openFactSuggestions.mockClear();
    const off = await renderPage();
    expect(off).toContain("About your business");
    expect(off).not.toContain("Waiting for you");
    expect(openFactSuggestions).not.toHaveBeenCalled();
  });

  it("says a list didn't load rather than showing it empty", async () => {
    process.env.ONBOARDING_ENABLED = "true";
    phase3On();
    listBusinessFacts.mockRejectedValue(new Error("unavailable"));
    listConversations.mockRejectedValue(new Error("unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const html = await renderPage();
    warn.mockRestore();
    expect(html.split("This list didn't load. Try again in a moment.").length - 1).toBe(2);
    expect(html).not.toContain("Nothing yet. Talk with Vizzy to add more.");
    expect(html).not.toContain("No conversations kept.");
  });

  it("comes before the languages on the older Settings, and only with nav v2's palette", async () => {
    process.env.ONBOARDING_ENABLED = "true";
    process.env.NEXT_PUBLIC_NAV_V2_ENABLED = "true";
    const html = await renderPage();
    expect(html.indexOf("About your business")).toBeGreaterThan(-1);
    expect(html.indexOf("About your business")).toBeLessThan(html.indexOf("Loading…"));
    expect(html).not.toContain("Brand details");

    delete process.env.NEXT_PUBLIC_NAV_V2_ENABLED;
    getTenantById.mockClear();
    expect(await renderPage()).not.toContain("About your business");
    expect(getTenantById).not.toHaveBeenCalled();
  });

  it("says where to add a missing domain without a dash", async () => {
    phase3On();
    getTenantById.mockResolvedValue(brand({ rootDomain: "" }));
    const html = await renderPage();
    expect(html).toContain("Not set. Add it under Sending.");
    expect(html).not.toContain("\u2014");
  });
});

describe("Settings › General, Learning (image style versions)", () => {
  const LEARNING = ["BRAND_STYLE_LOOP_ENABLED", "BRAND_IMAGE_STYLE_ENABLED", "IMAGE_STYLE_VERSIONS_ENABLED", "LOOPS_ENABLED", ...SWITCHES];
  const versionsOn = () => {
    process.env.BRAND_STYLE_LOOP_ENABLED = "true";
    process.env.BRAND_IMAGE_STYLE_ENABLED = "true";
    process.env.IMAGE_STYLE_VERSIONS_ENABLED = "true";
  };

  beforeEach(() => {
    for (const name of LEARNING) delete process.env[name];
    requireAdminContext.mockResolvedValue(CTX);
    getTenantById.mockResolvedValue({ tenantName: "Acme", rootDomain: "acme.example.com" });
    listBusinessFacts.mockResolvedValue([]);
    listConversations.mockResolvedValue([]);
    readBrandPointers.mockResolvedValue({ scopes: {} });
  });
  afterEach(() => {
    for (const name of LEARNING) delete process.env[name];
    vi.clearAllMocks();
  });

  it("isn't there, and reads nothing, with versions off", async () => {
    phase3On();
    expect(await renderPage()).not.toContain("Help check that learning works");
    expect(readBrandPointers).not.toHaveBeenCalled();
  });

  it("shows Help check that learning works, on, with step 4's words; and since when it is off", async () => {
    versionsOn();
    phase3On();
    const on = await renderPage();
    expect(on).toContain("Help check that learning works");
    expect(on).toContain("About 1 in 20 images is made without what YouGrow learned, so YouGrow can check that learning helps. Turn off to always use what it learned.");
    expect(on).toContain('href="/help/what-yougrow-learned#holdback"');
    readBrandPointers.mockResolvedValueOnce({ scopes: {}, fleetOptOut: { at: "2027-06-03T09:00:00.000Z" } });
    expect(await renderPage()).toContain("Off since 3 Jun. Every image is made with what YouGrow learned.");
  });

  it("with LOOPS_ENABLED on, says step 5's words: off also leaves the brand out of the counts across brands", async () => {
    versionsOn();
    phase3On();
    process.env.LOOPS_ENABLED = "true";
    const on = await renderPage();
    expect(on).toContain(
      "YouGrow counts, across every brand, how often what it learns is used, kept and liked: counts only, never images, words or people. Turning this off leaves this brand out of those counts and also stops the 1 in 20 images made without what YouGrow learned.",
    );
    expect(on).not.toContain("Turn off to always use what it learned.");
    readBrandPointers.mockResolvedValueOnce({ scopes: {}, fleetOptOut: { at: "2027-06-03T09:00:00.000Z" } });
    expect(await renderPage()).toContain("Off since 3 Jun. This brand's counts stay with this brand.");
  });

  it("is read only for a member, and stays out when its read fails", async () => {
    versionsOn();
    phase3On();
    requireAdminContext.mockResolvedValue({ ...CTX, role: "member" });
    expect(await renderPage()).toContain("Only admins can change it.");
    readBrandPointers.mockRejectedValueOnce(new Error("unavailable"));
    requireAdminContext.mockResolvedValue(CTX);
    expect(await renderPage()).not.toContain("Help check that learning works");
  });
});
