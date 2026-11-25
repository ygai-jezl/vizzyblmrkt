import { afterEach, describe, expect, it, vi } from "vitest";
import { REVEALABLE } from "@/lib/nav/reveal";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { failingFirestore } from "@/lib/tenant/testing/failingFirestore";
import { getTenantById } from "@/lib/tenant/registry";
import type { TenantContext } from "@/lib/tenant/types";
import type { BusinessProfile } from "@/lib/types/businessProfile";
import { factsFromSignals, growSidebarReveal, loadRevealFacts, revealAfterProfileSave, type RevealSignals } from "./revealFacts";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const B: TenantContext = { tenantId: "ten_B", region: "us", source: "idtoken", userId: "usr_other", role: "admin" };
const AT = "2026-11-25T10:00:00.000Z";
const ALL = [...REVEALABLE];
const NONE: RevealSignals = {
  anyProgramme: false,
  anyConnection: false,
  welcomeEmailLive: false,
  anyProductJourney: false,
  signups: 0,
  postsScheduled: 0,
  newslettersSent: 0,
};

function brands(over: Record<string, unknown> = {}): FakeFirestore {
  const db = new FakeFirestore();
  for (const [id, extra] of [
    ["ten_A", over],
    ["ten_B", {}],
  ] as const) {
    db.seed("tenants", id, {
      tenantName: `Brand ${id}`,
      rootDomain: `${id}.example.com`,
      status: "active",
      region: "us",
      allowedOrigins: [`https://${id}.example.com`],
      ownerId: "usr_owner",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      ...extra,
    });
  }
  return db;
}

afterEach(() => vi.restoreAllMocks());

describe("factsFromSignals", () => {
  it("reads every free fact from the growth signals", () => {
    expect([...factsFromSignals(NONE)]).toEqual([]);
    expect([...factsFromSignals({ ...NONE, anyProgramme: true })]).toEqual(["content"]);
    expect([...factsFromSignals({ ...NONE, anyConnection: true })]).toEqual(["products"]);
    expect([...factsFromSignals({ ...NONE, welcomeEmailLive: true })]).toEqual(["journeys"]);
    expect([...factsFromSignals({ ...NONE, anyProductJourney: true })]).toEqual(["journeys"]);
    expect([...factsFromSignals({ ...NONE, signups: 2 })]).toEqual(["audience", "insights"]);
    expect([...factsFromSignals({ ...NONE, postsScheduled: 1 })]).toEqual(["insights"]);
    expect([...factsFromSignals({ ...NONE, newslettersSent: 1 })]).toEqual(["insights"]);
    expect([...factsFromSignals({ ...NONE, signups: null })]).toEqual([]);
  });
});

describe("loadRevealFacts, without signals (the welcome's finish)", () => {
  it("finds nothing for a new brand", async () => {
    expect(await loadRevealFacts(A, ALL, {}, new FakeFirestore())).toEqual({ has: [], unknown: [] });
  });

  it("gives a brand with contacts only People, and Insights with it", async () => {
    const db = new FakeFirestore();
    db.seed("contacts", "ct_1", { tenantId: "ten_A", email: "pat@example.com" });
    expect(await loadRevealFacts(A, ALL, {}, db)).toEqual({ has: ["audience", "insights"], unknown: [] });
  });

  it("counts a sign-up in any status, a company, an engaged profile and a product user as People", async () => {
    for (const [collection, row] of [
      ["signups", { status: "offboarded", email: "sam@example.com" }],
      ["companies", { name: "Example Ltd" }],
      ["social_engaged", { name: "A made-up person" }],
      ["product_users", { userId: "u_1" }],
    ] as const) {
      const db = new FakeFirestore();
      db.seed(collection, "x1", { tenantId: "ten_A", ...row });
      expect((await loadRevealFacts(A, ["audience"], {}, db)).has, collection).toEqual(["audience"]);
    }
  });

  it("gives an archived programme Content, and a sandbox connection Products", async () => {
    const db = new FakeFirestore();
    db.seed("workspaces", "w_arch", { tenantId: "ten_A", name: "Old", archivedAt: AT });
    db.seed("product_connections", "pc_sandbox", { tenantId: "ten_A", kind: "sandbox", status: "revoked" });
    expect(await loadRevealFacts(A, ALL, {}, db)).toEqual({ has: ["content", "products"], unknown: [] });
  });

  it("doesn't give a drafted welcome email Journeys, and does a live one or a product journey", async () => {
    const drafted = new FakeFirestore();
    drafted.seed("journeys", "journey_c1", { tenantId: "ten_A", status: "draft" });
    drafted.seed("lifecycle_journeys", "lcj_w", { tenantId: "ten_A", status: "draft", connectionId: "", audience: { kind: "waitlist", campaignId: "c1" } });
    expect((await loadRevealFacts(A, ["journeys"], {}, drafted)).has).toEqual([]);

    const live = new FakeFirestore();
    live.seed("journeys", "journey_c1", { tenantId: "ten_A", status: "active" });
    expect((await loadRevealFacts(A, ["journeys"], {}, live)).has).toEqual(["journeys"]);

    const moved = new FakeFirestore();
    moved.seed("lifecycle_journeys", "lcj_w", { tenantId: "ten_A", status: "active", connectionId: "", audience: { kind: "waitlist", campaignId: "c1" } });
    expect((await loadRevealFacts(A, ["journeys"], {}, moved)).has).toEqual(["journeys"]);

    const product = new FakeFirestore();
    product.seed("lifecycle_journeys", "lcj_p", { tenantId: "ten_A", status: "archived", connectionId: "pc_1", audience: { kind: "product", connectionId: "pc_1" } });
    expect((await loadRevealFacts(A, ["journeys"], {}, product)).has).toEqual(["journeys"]);
  });

  it("gives a scheduled post or a sent newsletter Insights, and not a follow-up job or a draft", async () => {
    const db = new FakeFirestore();
    db.seed("campaign_scheduled_posts", "p_fetch", { tenantId: "ten_A", jobKind: "performance_fetch" });
    db.seed("broadcasts", "b_draft", { tenantId: "ten_A", audienceMode: "weekly", status: "draft" });
    expect((await loadRevealFacts(A, ["insights"], {}, db)).has).toEqual([]);
    db.seed("campaign_scheduled_posts", "p_pub", { tenantId: "ten_A", jobKind: "publish" });
    expect((await loadRevealFacts(A, ["insights"], {}, db)).has).toEqual(["insights"]);
    const sent = new FakeFirestore();
    sent.seed("broadcasts", "b_sent", { tenantId: "ten_A", audienceMode: "weekly", status: "sent" });
    expect((await loadRevealFacts(A, ["insights"], {}, sent)).has).toEqual(["insights"]);
  });

  it("never sees another brand's records", async () => {
    const db = new FakeFirestore();
    db.seed("workspaces", "w_b", { tenantId: "ten_B", name: "Theirs" });
    db.seed("contacts", "ct_b", { tenantId: "ten_B", email: "kim@example.com" });
    db.seed("product_connections", "pc_b", { tenantId: "ten_B", kind: "custom", status: "active" });
    db.seed("journeys", "journey_b", { tenantId: "ten_B", status: "active" });
    expect(await loadRevealFacts(A, ALL, {}, db)).toEqual({ has: [], unknown: [] });
    expect((await loadRevealFacts(B, ALL, {}, db)).has).toEqual(["content", "products", "journeys", "audience", "insights"]);
  });

  it("leaves a section unknown when its read fails and nothing else found data", async () => {
    const db = new FakeFirestore();
    const failing = failingFirestore(db, { collections: ["contacts", "workspaces"] });
    expect(await loadRevealFacts(A, ALL, {}, failing)).toEqual({ has: [], unknown: ["content", "audience", "insights"] });
    db.seed("signups", "s1", { tenantId: "ten_A", status: "verified_active" });
    expect(await loadRevealFacts(A, ALL, {}, failing)).toEqual({ has: ["audience", "insights"], unknown: ["content"] });
  });

  it("reads only the sections it's asked about", async () => {
    const db = new FakeFirestore();
    await loadRevealFacts(A, ["content"], {}, db);
    expect(db.collectionCalls("workspaces")).toBe(1);
    for (const c of ["signups", "contacts", "product_connections", "journeys", "lifecycle_journeys", "broadcasts"]) expect(db.collectionCalls(c), c).toBe(0);
    await loadRevealFacts(A, [], {}, db);
    expect(db.collectionCalls("workspaces")).toBe(1);
  });
});

describe("loadRevealFacts, with the growth signals", () => {
  it("reads nothing for what the signals show, and only People's reads for the rest", async () => {
    const db = new FakeFirestore();
    const facts = await loadRevealFacts(A, ALL, { signals: { ...NONE, anyProgramme: true, signups: 3 } }, db);
    expect(facts).toEqual({ has: ["content", "audience", "insights"], unknown: [] });
    for (const c of ["signups", "contacts", "workspaces", "product_connections"]) expect(db.collectionCalls(c), c).toBe(0);

    const people = new FakeFirestore();
    people.seed("product_users", "pu_1", { tenantId: "ten_A", userId: "u_1" });
    expect(await loadRevealFacts(A, ALL, { signals: NONE }, people)).toEqual({ has: ["audience", "insights"], unknown: [] });
    expect(people.collectionCalls("workspaces")).toBe(0);
  });

  it("doesn't decide People from unknown sign-up counts: the reads do, and a failed one leaves it unknown", async () => {
    const empty = new FakeFirestore();
    expect(await loadRevealFacts(A, ["audience", "insights"], { signals: { ...NONE, signups: null } }, empty)).toEqual({ has: [], unknown: [] });
    const failing = failingFirestore(new FakeFirestore(), { collections: ["signups"] });
    expect(await loadRevealFacts(A, ["audience", "insights"], { signals: { ...NONE, signups: null } }, failing)).toEqual({
      has: [],
      unknown: ["audience", "insights"],
    });
    // A post shows Insights whatever People's reads say.
    expect(await loadRevealFacts(A, ["audience", "insights"], { signals: { ...NONE, signups: null, postsScheduled: 1 } }, failing)).toEqual({
      has: ["insights"],
      unknown: ["audience"],
    });
  });
});

describe("growSidebarReveal (the growth route)", () => {
  const profile = (answers: BusinessProfile["answers"]): BusinessProfile => ({ status: "done", answers, rev: 1, startedAt: AT });

  it("stores the sections that now hold data, and writes only when the set grows", async () => {
    const db = brands({ sidebarReveal: { shown: [], opened: [], startedAt: AT } });
    const tenant = (await getTenantById("ten_A", db))!;
    const first = await growSidebarReveal(A, { sidebarReveal: tenant.sidebarReveal!, businessProfile: profile({ want: "waitlist" }) }, NONE, db);
    expect(first).toEqual({ shown: [] });
    expect(db.writeCountFor("tenants", "ten_A")).toBe(0);

    const grown = await growSidebarReveal(A, { sidebarReveal: tenant.sidebarReveal!, businessProfile: profile({ want: "waitlist" }) }, { ...NONE, anyProgramme: true }, db);
    expect(grown).toEqual({ shown: ["content"] });
    expect(db.raw("tenants", "ten_A")!.sidebarReveal).toMatchObject({ shown: ["content"] });
    expect(db.writeCountFor("tenants", "ten_A")).toBe(1);

    const again = (await getTenantById("ten_A", db))!;
    await growSidebarReveal(A, { sidebarReveal: again.sidebarReveal!, businessProfile: profile({ want: "waitlist" }) }, { ...NONE, anyProgramme: true }, db);
    expect(db.writeCountFor("tenants", "ten_A")).toBe(1);
  });

  it("shows what's stored, opened and fits, and stores fit that isn't yet (an answer changed)", async () => {
    const db = brands({ sidebarReveal: { shown: ["insights"], opened: [{ key: "products", at: AT }], startedAt: AT } });
    const tenant = (await getTenantById("ten_A", db))!;
    const view = await growSidebarReveal(A, { sidebarReveal: tenant.sidebarReveal!, businessProfile: profile({ want: "customers" }) }, NONE, db);
    expect(view).toEqual({ shown: ["products", "journeys", "audience", "insights"] });
    expect(db.raw("tenants", "ten_A")!.sidebarReveal).toMatchObject({ shown: ["insights", "journeys", "audience"] });
  });

  it("shows an unknown section without storing it", async () => {
    const db = brands({ sidebarReveal: { shown: [], opened: [], startedAt: AT } });
    const tenant = (await getTenantById("ten_A", db))!;
    const failing = failingFirestore(db, { collections: ["signups"] });
    const view = await growSidebarReveal(A, { sidebarReveal: tenant.sidebarReveal! }, { ...NONE, signups: null }, failing);
    expect(view).toEqual({ shown: ["audience", "insights"] });
    expect(db.writeCountFor("tenants", "ten_A")).toBe(0);
  });
});

describe("revealAfterProfileSave", () => {
  const started: BusinessProfile = { status: "started", answers: {}, rev: 0, startedAt: AT };
  const now = () => Date.parse("2026-11-25T11:00:00.000Z");

  it("starts Coming up when the welcome first finishes with answers: fit plus data, once", async () => {
    const db = brands();
    db.seed("contacts", "ct_1", { tenantId: "ten_A", email: "pat@example.com" });
    const after: BusinessProfile = { status: "done", via: "questions", answers: { want: "audience", run: "shop" }, rev: 2, startedAt: AT };
    await revealAfterProfileSave(A, { before: started, after }, { db, now });
    expect((await getTenantById("ten_A", db))?.sidebarReveal).toEqual({
      shown: ["content", "audience", "insights"],
      opened: [],
      startedAt: "2026-11-25T11:00:00.000Z",
    });
    expect(db.raw("tenants", "ten_B")!.sidebarReveal).toBeUndefined();
  });

  it("starts it for an idea with a waitlist too: nothing fits, so 5 wait", async () => {
    const db = brands();
    const after: BusinessProfile = { status: "done", answers: { who: "solo", run: "app", stage: "idea", want: "waitlist" }, rev: 4, startedAt: AT };
    await revealAfterProfileSave(A, { before: started, after }, { db, now });
    expect((await getTenantById("ten_A", db))?.sidebarReveal?.shown).toEqual([]);
  });

  it("keeps today's sidebar when the questions finished with every one skipped", async () => {
    const db = brands();
    await revealAfterProfileSave(A, { before: started, after: { ...started, status: "done" } }, { db, now });
    expect(db.raw("tenants", "ten_A")!.sidebarReveal).toBeUndefined();
  });

  it("keeps today's sidebar for Skip, Settings alone, a skipped brand later and a brand done before", async () => {
    const db = brands();
    const answers = { want: "audience" } as const;
    const cases: Array<{ before: BusinessProfile | null; after: BusinessProfile }> = [
      { before: started, after: { ...started, status: "skipped" } },
      { before: null, after: { status: "done", via: "settings", answers, rev: 1, startedAt: AT } },
      { before: started, after: { ...started, via: "settings", answers, rev: 1 } },
      { before: { ...started, status: "skipped" }, after: { status: "done", via: "voice", answers, rev: 1, startedAt: AT } },
      { before: { ...started, status: "done", rev: 3 }, after: { status: "done", via: "voice", answers, rev: 4, startedAt: AT } },
    ];
    for (const saved of cases) await revealAfterProfileSave(A, saved, { db, now });
    expect(db.raw("tenants", "ten_A")!.sidebarReveal).toBeUndefined();
  });

  it("adds what a changed answer now fits to a brand with Coming up, and nothing when the answers didn't change", async () => {
    const db = brands({ sidebarReveal: { shown: ["content"], opened: [], startedAt: AT } });
    const before: BusinessProfile = { status: "done", answers: { want: "audience" }, rev: 2, startedAt: AT };
    await revealAfterProfileSave(A, { before, after: { ...before, answers: { want: "customers" }, rev: 3 } }, { db, now });
    expect(db.raw("tenants", "ten_A")!.sidebarReveal).toMatchObject({ shown: ["content", "journeys", "audience"] });
    const writes = db.writeCountFor("tenants", "ten_A");
    await revealAfterProfileSave(A, { before: { ...before, rev: 3 }, after: { ...before, rev: 3 } }, { db, now });
    expect(db.writeCountFor("tenants", "ten_A")).toBe(writes);
  });

  it("never fails the save when the sidebar can't be written", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = failingFirestore(brands(), { collections: ["tenants"] });
    const after: BusinessProfile = { status: "done", answers: { want: "audience" }, rev: 1, startedAt: AT };
    await expect(revealAfterProfileSave(A, { before: started, after }, { db: failing, now })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
