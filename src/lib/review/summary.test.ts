import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import {
  agentJourneyItem,
  agentLaunchJourneyItem,
  agentInviteWaveItem,
  agentContentPlanItem,
  brandMapItem,
  competitorItems,
  connectionItem,
  contentHubItem,
  dataSourceItem,
  countReview,
  failedPostItem,
  forgetReviewCount,
  loadReview,
  repoResultsItem,
  resetReviewCountCache,
  REVIEW_ORDER,
  REVIEW_SECTIONS,
} from "./summary";
import type { RepoAnalysis } from "@/lib/types/repoAnalysis";
import { freshCollect, type DataConnection } from "@/lib/types/dataConnection";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };

const analysis = (over: Partial<RepoAnalysis> = {}): RepoAnalysis =>
  ({
    id: "ra_1",
    tenantId: "ten_A",
    connectionId: "pc_1",
    productName: "Fernlight",
    repos: [{ label: "app" }],
    status: "done",
    map: { onboardingSteps: [{ id: "s1", label: "Adds household" }], events: [{ name: "plan_generated" }] },
    createdAt: "2026-09-20T00:00:00Z",
    createdBy: null,
    ...over,
  }) as unknown as RepoAnalysis;

describe("per-source rules", () => {
  it("repo results: finished, unaccepted runs only", () => {
    const conn = { id: "pc_1", name: "Fernlight app" };
    const item = repoResultsItem(conn, analysis());
    expect(item?.title).toBe("Fernlight app: 2 items to review");
    expect(item?.href).toBe("/admin/products/pc_1?tab=learn");
    expect(repoResultsItem(conn, analysis({ acceptedAt: "2026-09-21T00:00:00Z" }))).toBeNull();
    expect(repoResultsItem(conn, analysis({ status: "running" }))).toBeNull();
    expect(repoResultsItem(conn, analysis({ map: null }))).toBeNull();
    expect(repoResultsItem(conn, undefined)).toBeNull();
  });

  it("Vizzy drafts: agent-authored and never published", () => {
    const j = { id: "lcj_1", name: "Re-engage", authoredBy: "agent" as const, publishedVersion: null, status: "draft" as const };
    expect(agentJourneyItem(j)?.href).toBe("/admin/lifecycle/lcj_1");
    expect(agentJourneyItem({ ...j, publishedVersion: 1 })).toBeNull();
    expect(agentJourneyItem({ ...j, authoredBy: "human" })).toBeNull();
    expect(agentJourneyItem({ ...j, status: "archived" })).toBeNull();
  });

  it("launch welcome journeys with Vizzy-written emails that are still off", () => {
    const graph = { nodes: [{ id: "e1", type: "email", position: { x: 0, y: 0 }, data: { agentMeta: { source: "agent3" } } }], edges: [] };
    const j = { id: "journey_c1", campaignId: "c1", status: "draft" as const, graph };
    expect(agentLaunchJourneyItem(j as never, "Beta")?.title).toBe("Welcome emails for Beta");
    expect(agentLaunchJourneyItem({ ...j, status: "active" } as never, "Beta")).toBeNull();
    const human = { ...j, graph: { ...graph, nodes: [{ ...graph.nodes[0]!, data: { agentMeta: { source: "human" } } }] } };
    expect(agentLaunchJourneyItem(human as never, "Beta")).toBeNull();
  });

  it("content: a written hub that isn't approved", () => {
    const ws = { id: "w1", name: "Weekly" };
    const plan = (status: string, body = "Hello") => ({
      id: "p1",
      name: "Batch cooking",
      graph: { nodes: [{ id: "h", type: "hub", status, body }], edges: [] },
    });
    expect(contentHubItem(ws, plan("generated") as never)?.href).toBe("/admin/workspace/w1/create/p1");
    expect(contentHubItem(ws, plan("approved") as never)).toBeNull();
    expect(contentHubItem(ws, plan("generated", "  ") as never)).toBeNull();
  });

  it("failed posts say what to fix", () => {
    const post = { id: "sp1", workspaceId: "w1", channel: "linkedin" as const, scheduledAt: "2026-09-22T08:00:00Z" };
    expect(failedPostItem({ ...post, lastError: "linkedin_not_connected" }, "Weekly")).toMatchObject({
      title: "Connect LinkedIn to publish this post",
      href: "/admin/account/connections",
      detail: "LinkedIn · Weekly · was due 22 Sept",
    });
    expect(failedPostItem({ ...post, lastError: "x_publish:403" }, undefined).href).toBe("/admin/workspace/w1/distribute");
    expect(failedPostItem({ ...post, lastError: null }, undefined).title).toBe("A post couldn't publish");
  });

  it("connections alert after repeated context failures", () => {
    const c = { id: "pc_1", name: "App", kind: "custom" as const, status: "active" as const };
    expect(connectionItem({ ...c, health: { consecutiveContextFailures: 2 } } as never)).toBeNull();
    expect(connectionItem({ ...c, health: { consecutiveContextFailures: 3, lastContextError: "timeout" } } as never)?.detail).toBe(
      "3 failures in a row · timeout",
    );
    expect(connectionItem({ ...c, kind: "sandbox", health: { consecutiveContextFailures: 9 } } as never)).toBeNull();
  });
});

describe("invite waves in Review (nav v2 phase 4)", () => {
  it("lists a wave Vizzy drafted until someone sends it", () => {
    const w = { id: "wav_1", campaignId: "beta", status: "draft", authoredBy: "agent", size: 120 } as const;
    expect(agentInviteWaveItem(w, "Fernlight Beta")).toMatchObject({
      kind: "agent_draft",
      title: "Invite 120 people from Fernlight Beta",
      href: "/admin/launches/beta/invites?wave=wav_1",
    });
    expect(agentInviteWaveItem({ ...w, status: "sent" }, "Fernlight Beta")).toBeNull();
    expect(agentInviteWaveItem({ ...w, authoredBy: "human" }, "Fernlight Beta")).toBeNull();
  });
});

describe("content plans from Vizzy (nav v2 phase 4)", () => {
  const ws = { id: "ws1", name: "The Weekly Plate" };
  const plan = (over: Record<string, unknown> = {}) =>
    ({
      id: "p1",
      name: "Five 15-minute dinners",
      status: "generating",
      authoredBy: "agent",
      graph: { nodes: [{ id: "hub", type: "hub", status: "generated", body: "x" }], edges: [] },
      ...over,
    }) as never;

  it("lists an agent's plan until a person approves any of it", () => {
    expect(agentContentPlanItem(ws, plan())).toMatchObject({
      kind: "agent_draft",
      detail: "The Weekly Plate · content plan drafted by Vizzy · approve the hub to continue",
      href: "/admin/workspace/ws1/create/p1",
    });
    expect(agentContentPlanItem(ws, plan({ authoredBy: "human" }))).toBeNull();
    expect(agentContentPlanItem(ws, plan({ graph: { nodes: [{ id: "hub", type: "hub", status: "approved" }], edges: [] } }))).toBeNull();
    expect(agentContentPlanItem(ws, plan({ status: "scheduled" }))).toBeNull();
  });
});

describe("brand map suggestions in Review", () => {
  afterEach(() => vi.unstubAllEnvs());
  const sg = (from: "research" | "article" | "vizzy") => ({ from }) as never;

  it("is one row, however many wait, saying where they came from", () => {
    expect(brandMapItem(null)).toBeNull();
    expect(brandMapItem({ suggestions: [] })).toBeNull();
    expect(brandMapItem({ suggestions: [sg("vizzy")] })).toMatchObject({ title: "1 suggestion for your brand map", detail: "From Vizzy", href: "/admin/brand-kit/map" });
    expect(brandMapItem({ suggestions: [sg("article"), sg("research"), sg("article"), sg("vizzy")] })).toMatchObject({
      id: "brand_map",
      kind: "brand_map",
      title: "4 suggestions for your brand map",
      detail: "From research, your articles and Vizzy",
      action: "Review",
    });
  });

  it("is read only with the brand map switched on", async () => {
    const db = new FakeFirestore();
    db.seed("brand_maps", "bm_ten_A", {
      tenantId: "ten_A",
      rev: 1,
      identity: { name: "Acme" },
      subjects: [],
      names: [],
      suggestions: [
        { id: "sg_aaaaaaaa", key: "subject:audits", change: { type: "add_subject", name: "Audits" }, reason: "", from: "research", at: "2026-10-15T00:00:00Z" },
      ],
      dismissed: [],
      createdAt: "2026-10-15T00:00:00Z",
      updatedAt: "2026-10-15T00:00:00Z",
    });
    expect((await loadReview(ctx, { lifecycle: false, includeContent: false }, db)).items).toEqual([]);
    vi.stubEnv("BRAND_MAP_ENABLED", "true");
    expect((await loadReview(ctx, { lifecycle: false, includeContent: false }, db)).items.map((i) => i.title)).toEqual(["1 suggestion for your brand map"]);
  });
});

describe("loadReview", () => {
  beforeEach(() => resetReviewCountCache());

  function seed(db: FakeFirestore) {
    db.seed("campaign_scheduled_posts", "sp1", {
      tenantId: "ten_A",
      workspaceId: "w1",
      channel: "x",
      jobKind: "publish",
      status: "failed",
      lastError: "x_not_connected",
      scheduledAt: "2026-09-22T08:00:00Z",
    });
    db.seed("campaign_scheduled_posts", "sp2", { tenantId: "ten_A", jobKind: "publish", status: "done" });
    db.seed("workspaces", "w1", { tenantId: "ten_A", name: "Weekly", createdAt: "2026-09-01T00:00:00Z" });
    db.seed("product_connections", "pc_1", {
      tenantId: "ten_A",
      name: "Fernlight app",
      kind: "custom",
      status: "active",
      health: { consecutiveContextFailures: 4 },
    });
    db.seed("repo_analyses", "ra_1", analysis() as unknown as Record<string, unknown>);
    db.seed("lifecycle_journeys", "lcj_1", {
      tenantId: "ten_A",
      name: "Re-engage",
      authoredBy: "agent",
      publishedVersion: null,
      status: "draft",
    });
    db.seed("lifecycle_drafts", "lcd_1", {
      tenantId: "ten_A",
      status: "awaiting_approval",
      approvalDeadline: "2999-01-01T00:00:00Z",
    });
    db.seed("product_connections", "pc_other", {
      tenantId: "ten_B",
      name: "Other",
      kind: "custom",
      status: "active",
      health: { consecutiveContextFailures: 9 },
    });
  }

  it("gathers every source, tenant-scoped", async () => {
    const db = new FakeFirestore();
    seed(db);
    const r = await loadReview(ctx, { lifecycle: true, includeContent: false }, db);
    expect(r.aiLines).toBe(1);
    expect(r.items.map((i) => i.kind)).toEqual(["failed_post", "connection", "agent_draft", "repo_results"]);
    expect(r.items[0]!.detail).toContain("Weekly");
  });

  it("lists only non-lifecycle sources when lifecycle is off", async () => {
    const db = new FakeFirestore();
    seed(db);
    const r = await loadReview(ctx, { lifecycle: false, includeContent: false }, db);
    expect(r.aiLines).toBe(0);
    expect(r.items.map((i) => i.kind)).toEqual(["failed_post"]);
  });

  it("countReview totals AI lines and items, and caches per tenant", async () => {
    const db = new FakeFirestore();
    seed(db);
    expect(await countReview(ctx, { lifecycle: true, now: 1_000 }, db)).toBe(5);
    db.seed("lifecycle_drafts", "lcd_2", { tenantId: "ten_A", status: "awaiting_approval", approvalDeadline: "2999-01-01T00:00:00Z" });
    expect(await countReview(ctx, { lifecycle: true, now: 2_000 }, db)).toBe(5); // cached
    expect(await countReview(ctx, { lifecycle: true, now: 1_000 + 3 * 60_000 }, db)).toBe(6);
  });
});

describe("the brand map's row, with the map at any size", () => {
  it("counts proposals with suggestions, and says so", () => {
    const map = { suggestions: [{ from: "research" }] } as never;
    expect(brandMapItem(map, 0)?.title).toBe("1 suggestion for your brand map");
    expect(brandMapItem(map, 4)).toMatchObject({ title: "5 waiting on your brand map", detail: "From research, and new subjects and questions" });
    expect(brandMapItem({ suggestions: [] } as never, 2)).toMatchObject({ title: "2 waiting on your brand map", detail: "New subjects and questions to look at" });
    expect(brandMapItem({ suggestions: [] } as never, 0)).toBeNull();
  });

  it("counts a suggestion about a subject once: as the proposal it became", () => {
    vi.stubEnv("BRAND_MAP_ENABLED", "true");
    vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
    const map = {
      suggestions: [
        { from: "research", change: { type: "add_subject", name: "Audits" } },
        { from: "vizzy", change: { type: "add_name", name: "Rivalco", kind: "alternative" } },
      ],
    } as never;
    // "Audits" is a proposal on the records now (1): counted there, not on the list as well.
    expect(brandMapItem(map, 1)).toMatchObject({ title: "2 waiting on your brand map", detail: "From Vizzy, and new subjects and questions" });
    vi.unstubAllEnvs();
  });
});

describe("what competitors changed, in Review", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("one row per competitor with unseen changes, newest first, and one for a competitor that needs you", () => {
    const items = competitorItems(
      [
        { id: "cmp_a00000001", name: "Acme Dental", status: "watching", problem: null },
        { id: "cmp_b00000001", name: "Brightsmile", status: "needs_you", problem: "no_sitemap" },
        { id: "cmp_c00000001", name: "Quiet Co", status: "watching", problem: null },
      ],
      [
        { competitorId: "cmp_a00000001", headline: "18 pages added under /locations/", at: "2026-11-01T00:00:00Z" },
        { competitorId: "cmp_a00000001", headline: "3 new posts on implants", at: "2026-11-09T00:00:00Z" },
      ],
    );
    expect(items).toEqual([
      {
        id: "cmp:cmp_a00000001",
        kind: "competitor_news",
        title: "Acme Dental: 3 new posts on implants",
        detail: "And 1 more change since you last looked",
        href: "/admin/brand-kit/competitors/cmp_a00000001",
        action: "Open",
        markSeen: { competitorId: "cmp_a00000001" },
      },
      expect.objectContaining({ id: "cmp_needs:cmp_b00000001", title: "Brightsmile needs you", href: "/admin/brand-kit/competitors/cmp_b00000001" }),
    ]);
  });

  it("are loaded only with the switch on, and Mark seen can clear the cached count", async () => {
    const db = new FakeFirestore();
    db.seed("competitors", "cmp_a00000001", { tenantId: "ten_A", name: "Acme Dental", status: "watching", problem: null, createdAt: "2026-11-01T00:00:00Z" });
    db.seed("competitor_changes", "cc_1", { tenantId: "ten_A", competitorId: "cmp_a00000001", headline: "3 new posts", at: "2026-11-09T00:00:00Z", seenAt: null });
    db.seed("competitor_changes", "cc_2", { tenantId: "ten_B", competitorId: "cmp_b", headline: "Not ours", at: "2026-11-09T00:00:00Z", seenAt: null });
    expect((await loadReview(ctx, { lifecycle: false, includeContent: false }, db)).items).toEqual([]);
    vi.stubEnv("COMPETITORS_ENABLED", "true");
    const r = await loadReview(ctx, { lifecycle: false, includeContent: false }, db);
    expect(r.items.map((i) => i.title)).toEqual(["Acme Dental: 3 new posts"]);

    resetReviewCountCache();
    expect(await countReview(ctx, { lifecycle: false, now: 1_000 }, db)).toBe(1);
    db.seed("competitor_changes", "cc_1", { tenantId: "ten_A", competitorId: "cmp_a00000001", headline: "3 new posts", at: "2026-11-09T00:00:00Z", seenAt: "2026-11-10T00:00:00Z" });
    expect(await countReview(ctx, { lifecycle: false, now: 2_000 }, db)).toBe(1); // cached
    forgetReviewCount("ten_A");
    expect(await countReview(ctx, { lifecycle: false, now: 3_000 }, db)).toBe(0);
  });
});

describe("Vizzy's suggestions about people", () => {
  const vizzy: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "u_admin", role: "admin" };
  const by = { type: "member", id: "u_admin" } as const;
  const SEATS = "fld_eeeeeeeeeee1";
  const PLAN = "fld_eeeeeeeeeee2";
  afterEach(() => vi.unstubAllEnvs());

  async function world() {
    const { saveFieldListChange } = await import("@/lib/audience/fieldList");
    const { deterministicContactId } = await import("@/lib/crm/identifiers");
    const db = new FakeFirestore();
    await saveFieldListChange(vizzy, "person", { baseRev: 0, change: { op: "add", label: "Seats", type: "number" }, by, newFieldId: () => SEATS }, db);
    await saveFieldListChange(vizzy, "person", { baseRev: 1, change: { op: "add", label: "Plan", type: "select", options: ["Pro"] }, by, newFieldId: () => PLAN, newOptionId: () => "opt_eeeeee01" }, db);
    const person = deterministicContactId("ten_A", "rosa.diaz@example.com");
    db.seed("contacts", person, { tenantId: "ten_A", email: "rosa.diaz@example.com", firstName: "Rosa", lastName: "Diaz", fields: { [SEATS]: 3 } });
    return { db, person };
  }

  it("are listed with the switch on, linking to the person's page, with no name, address or value", async () => {
    const { suggestFieldChanges } = await import("@/lib/audience/fieldSuggestions");
    const { db, person } = await world();
    for (const k of ["AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED", "AUDIENCE_VIZZY_FIELDS_ENABLED"]) vi.stubEnv(k, "true");
    const one = await suggestFieldChanges(vizzy, { personId: person, changes: { [SEATS]: 7 }, why: "Rosa Diaz added four people." }, { db });
    if (!one.ok) throw new Error(one.error);
    const r = await loadReview(ctx, { lifecycle: false, includeContent: false }, db);
    expect(r.items).toEqual([
      {
        id: `aa:${one.action.id}`,
        kind: "person_suggestion",
        title: "Vizzy suggests a change to Seats",
        detail: "On one person's page. Nothing changes until someone confirms.",
        href: `/admin/crm/people/${person}#vizzy`,
        action: "Review",
      },
    ]);
    const two = await suggestFieldChanges(vizzy, { personId: person, changes: { [SEATS]: 8, [PLAN]: "opt_eeeeee01" } }, { db });
    if (!two.ok) throw new Error(two.error);
    const again = await loadReview(ctx, { lifecycle: false, includeContent: false }, db);
    // The newer one replaced the first, which was for the same field.
    expect(again.items.map((i) => [i.title, i.detail])).toEqual([["Vizzy suggests changes to 2 fields", "Seats, Plan · On one person's page. Nothing changes until someone confirms."]]);
    expect(JSON.stringify(again.items)).not.toMatch(/Rosa|Diaz|example\.com|\b8\b/);

    vi.stubEnv("AUDIENCE_VIZZY_FIELDS_ENABLED", "false");
    expect((await loadReview(ctx, { lifecycle: false, includeContent: false }, db)).items).toEqual([]);
  });
});

describe("New person forms Vizzy filled in", () => {
  afterEach(() => vi.unstubAllEnvs());

  const admin: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u_admin", role: "admin" };
  const member: TenantContext = { ...admin, userId: "u_member", role: "member" };

  async function drafted() {
    const { draftNewPerson } = await import("@/lib/audience/personDrafts");
    const db = new FakeFirestore();
    for (const k of [
      "NEXT_PUBLIC_NAV_V2_ENABLED",
      "NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED",
      "NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED",
      "AUDIENCE_PERSON_LINKS_ENABLED",
      "AUDIENCE_ONE_VIEW_ENABLED",
      "ONTOLOGY_PERSON_IDS_ENABLED",
      "AUDIENCE_ADD_PERSON_ENABLED",
      "AUDIENCE_VIZZY_ADD_PERSON_ENABLED",
    ])
      vi.stubEnv(k, "true");
    const vizzy: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "u_admin", role: "admin" };
    const d = await draftNewPerson(vizzy, { email: "noor.haddad@example.com", firstName: "Noor" }, { db });
    if (!d.ok || d.outcome === "existing") throw new Error("not drafted");
    return { db, d };
  }

  it("are listed with their switch on, linking to the form by id, with nothing about the person", async () => {
    const { db, d } = await drafted();
    const r = await loadReview(admin, { lifecycle: false, includeContent: false }, db);
    expect(r.items).toEqual([
      {
        id: `aa:${d.action.id}`,
        kind: "person_suggestion",
        title: "Vizzy filled in New person for you",
        detail: "Check it, say how they agreed, and add them, or dismiss it. It goes after 7 days.",
        href: `/admin/crm?draft=${d.action.id}`,
        action: "Open",
      },
    ]);
    expect(JSON.stringify(r.items)).not.toMatch(/Noor|noor|example\.com/);
    vi.stubEnv("AUDIENCE_VIZZY_ADD_PERSON_ENABLED", "false");
    expect((await loadReview(admin, { lifecycle: false, includeContent: false }, db)).items).toEqual([]);
  });

  it("are for admins only, in the list and the count, since only admins add people", async () => {
    const { db } = await drafted();
    expect((await loadReview(member, { lifecycle: false, includeContent: false }, db)).items).toEqual([]);
    expect((await loadReview(ctx, { lifecycle: false, includeContent: false }, db)).items).toEqual([]);
    // Without the People screen (nav phase 3) the link would open no form.
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED", "false");
    expect((await loadReview(admin, { lifecycle: false, includeContent: false }, db)).items).toEqual([]);
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED", "true");
    resetReviewCountCache();
    expect(await countReview(admin, { lifecycle: false, now: 1_000 }, db)).toBe(1);
    // The admin's cached count never answers for a member.
    expect(await countReview(member, { lifecycle: false, now: 2_000 }, db)).toBe(0);
    forgetReviewCount("ten_A");
    vi.stubEnv("AUDIENCE_VIZZY_ADD_PERSON_ENABLED", "false");
    expect(await countReview(admin, { lifecycle: false, now: 3_000 }, db)).toBe(0);
  });
});

describe("data sources that need you", () => {
  const NOW = new Date("2026-11-23T10:00:00.000Z");
  const admin: TenantContext = { ...ctx, role: "admin", userId: "usr_admin" };
  const member: TenantContext = { ...ctx, role: "member", userId: "usr_member" };
  const health = { state: "ok" as const, lastOkAt: "2026-11-18T09:00:00.000Z", lastCheckedAt: "2026-11-18T09:00:00.000Z", lastErrorCode: null, failures: 0, pausedUntil: null };
  const conn = (over: Partial<DataConnection> = {}): DataConnection => ({
    id: "dcn_aaaaaaaaaaaaaaaaaaaa",
    tenantId: "ten_A",
    connectorId: "google-analytics",
    method: "share_access",
    label: "Google Analytics 4",
    account: "properties/123456789",
    ownerUid: "usr_admin",
    grants: [],
    secrets: {},
    health,
    pausedAt: null,
    pausedBy: null,
    recent: [],
    status: "connected",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    disconnectedAt: null,
    ...over,
  });

  beforeEach(() => {
    resetReviewCountCache();
    vi.stubEnv("CONNECTORS_ENABLED", "true");
    vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "true");
    vi.stubEnv("CONNECTOR_GA4_ENABLED", "true");
    vi.stubEnv("CONNECTORS_IDENTITIES_PROJECT", "made-up-identities");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("names a shared connection that lost its property, since when, and links to it on Connected", () => {
    const lost = conn({ health: { ...health, state: "broken", lastErrorCode: "share_access_lost", failures: 2, since: "2026-11-19T09:12:00.000Z" } });
    expect(dataSourceItem(lost, NOW)).toEqual({
      id: "data_source:dcn_aaaaaaaaaaaaaaaaaaaa",
      kind: "data_source",
      title: "Google Analytics 4 needs you",
      detail: "It can't read its property since 19 Nov, so no new numbers are collected. Add YouGrow's address to the property again.",
      href: "/admin/account/connections/connected?c=dcn_aaaaaaaaaaaaaaaaaaaa",
      action: "Fix",
    });
  });

  it("lists one with no property, one failing 3 days, and one paused a week, and nothing sooner", () => {
    expect(dataSourceItem(conn({ account: "" }), NOW)?.detail).toBe("It reads nothing until a property is chosen, so no numbers are collected.");
    const failing = (since: string) => conn({ collect: { ...freshCollect(), failedSince: since } });
    expect(dataSourceItem(failing("2026-11-20T09:00:00.000Z"), NOW)?.detail).toBe("Collecting its numbers has failed since 20 Nov, so the newest are missing. Press Check now on it to see why.");
    expect(dataSourceItem(failing("2026-11-21T09:00:00.000Z"), NOW)).toBeNull();
    expect(dataSourceItem(conn({ pausedAt: "2026-11-12T09:00:00.000Z", pausedBy: "usr_admin" }), NOW)).toMatchObject({ title: "Google Analytics 4 is paused", detail: expect.stringContaining("Paused since 12 Nov") });
    expect(dataSourceItem(conn({ pausedAt: "2026-11-20T09:00:00.000Z", pausedBy: "usr_admin" }), NOW)).toBeNull();
    expect(dataSourceItem(conn(), NOW)).toBeNull();
    // A connector this copy turned off reads nothing on purpose.
    vi.stubEnv("CONNECTOR_GA4_ENABLED", "false");
    expect(dataSourceItem(conn({ account: "" }), NOW)).toBeNull();
  });

  it("shows only to admins, only while collected numbers are on, in its own section after Connection problems", async () => {
    const db = new FakeFirestore();
    const { id, ...stored } = conn({ account: "" });
    db.seed("data_connections", id, stored as unknown as Record<string, unknown>);
    db.seed("data_connections", "dcn_bbbbbbbbbbbbbbbbbbbb", { ...stored, tenantId: "ten_B" } as unknown as Record<string, unknown>);
    expect((await loadReview(admin, { lifecycle: false, includeContent: false }, db)).items.map((i) => i.id)).toEqual(["data_source:dcn_aaaaaaaaaaaaaaaaaaaa"]);
    expect((await loadReview(member, { lifecycle: false, includeContent: false }, db)).items).toEqual([]);
    vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "false");
    expect((await loadReview(admin, { lifecycle: false, includeContent: false }, db)).items).toEqual([]);
    expect(REVIEW_ORDER.indexOf("data_source")).toBe(REVIEW_ORDER.indexOf("connection") + 1);
    expect(REVIEW_SECTIONS.data_source.title).toBe("Data sources that need you");
  });
});

describe("What your numbers suggest", () => {
  const admin: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
  const member: TenantContext = { ...admin, userId: "usr_member", role: "member" };
  const SC = "dcn_ssssssssssssssssssss";
  beforeEach(() => {
    vi.stubEnv("CONNECTORS_ENABLED", "true");
    vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "true");
    vi.stubEnv("CONNECTOR_SIGNALS_ENABLED", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("lists open suggestions to admins only, while signals are on, after Your next article", async () => {
    const { seedSearchConsole, seedSuggestion } = await import("@/lib/connectors/testing/signals");
    const db = new FakeFirestore();
    await seedSearchConsole(admin, db, SC);
    await seedSuggestion(admin, db, SC, "losing", { now: new Date() });
    const items = (await loadReview(admin, { lifecycle: false, includeContent: false }, db)).items.filter((i) => i.kind === "data_signal");
    expect(items).toEqual([expect.objectContaining({ title: "Fewer Google clicks to /care/fiddle-leaf-fig", action: "Plan an article", signal: { id: expect.stringMatching(/^dsg_[0-9a-f]{24}$/) } })]);
    expect((await loadReview(member, { lifecycle: false, includeContent: false }, db)).items.filter((i) => i.kind === "data_signal")).toEqual([]);
    vi.stubEnv("CONNECTOR_SIGNALS_ENABLED", "false");
    expect((await loadReview(admin, { lifecycle: false, includeContent: false }, db)).items.filter((i) => i.kind === "data_signal")).toEqual([]);
    expect(REVIEW_ORDER.indexOf("data_signal")).toBe(REVIEW_ORDER.indexOf("next_article") + 1);
    expect(REVIEW_SECTIONS.data_signal).toEqual({ title: "What your numbers suggest", description: "Searches and pages from Search Console worth an article. Plan one, or dismiss it." });
  });
});
