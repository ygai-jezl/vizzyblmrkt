import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { LOOPS } from "@/lib/loops/registry";
import type { TenantContext } from "@/lib/tenant/types";
import {
  agentJourneyItem,
  agentLaunchJourneyItem,
  agentInviteWaveItem,
  agentContentPlanItem,
  agentNotesItem,
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
  refreshItems,
  REVIEW_ORDER,
  REVIEW_SECTIONS,
  strategyCheckItem,
} from "./summary";
import { freshCheck } from "@/lib/brandStrategy/checkRules";
import type { StrategyCheck } from "@/lib/types/brandStrategy";
import type { FreshnessDueItem } from "@/lib/types/freshness";
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

  it("call a launch with no name an idea while the words are on", () => {
    const graph = { nodes: [{ id: "e1", type: "email", position: { x: 0, y: 0 }, data: { agentMeta: { source: "agent3" } } }], edges: [] };
    const j = { id: "journey_c1", campaignId: "c1", status: "draft" as const, graph };
    const lc = { id: "lcjw_c1", name: "Welcome", authoredBy: "agent" as const, publishedVersion: null, status: "draft" as const, audience: { kind: "waitlist" as const, campaignId: "c1" } };
    const wave = { id: "w1", campaignId: "c1", status: "draft" as const, authoredBy: "agent" as const, size: 120 };
    expect(agentLaunchJourneyItem(j as never, undefined)?.title).toBe("Welcome emails for a launch");
    expect(agentInviteWaveItem(wave as never, undefined)?.title).toBe("Invite 120 people from a launch");
    for (const k of ["NEXT_PUBLIC_NAV_V2_ENABLED", "NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED", "NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED", "NEXT_PUBLIC_NAV_IDEAS_ENABLED", "LAUNCH_IDEAS_ENABLED"]) vi.stubEnv(k, "true");
    try {
      expect(agentLaunchJourneyItem(j as never, undefined)?.title).toBe("Welcome emails for an idea");
      expect(agentJourneyItem(lc as never)?.title).toBe("Welcome emails for an idea");
      expect(agentInviteWaveItem(wave as never, undefined)?.title).toBe("Invite 120 people from an idea");
      expect(agentLaunchJourneyItem(j as never, "Beta")?.title).toBe("Welcome emails for Beta");
    } finally {
      vi.unstubAllEnvs();
    }
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

describe("the weekly strategy check, in Review", () => {
  afterEach(() => vi.unstubAllEnvs());
  const NOW = "2026-11-26T12:00:00.000Z";
  // Made-up situations and competitors.
  const open = (reasons: NonNullable<StrategyCheck["open"]>["reasons"]): StrategyCheck => ({
    ...freshCheck("2026-11-02T09:00:00.000Z", null),
    open: { key: "chk_abc123", raisedAt: NOW, reasons, actedAt: null },
  });
  const moved = open([
    { kind: "new_articles", ref: "sit_aaaaaa01", text: "Which pages do answer engines cite", count: 4, by: [{ name: "Peerly", count: 4 }] },
    { kind: "named", ref: "Bigsuite", text: "Bigsuite", count: 5, by: [] },
  ]);

  it("is one row with every reason in full, opening the Strategy tab, with Dismiss", () => {
    expect(strategyCheckItem(null, NOW)).toBeNull();
    expect(strategyCheckItem(freshCheck(NOW, null), NOW)).toBeNull();
    expect(strategyCheckItem(moved, NOW)).toEqual({
      id: "strategy_check:chk_abc123",
      kind: "strategy_check",
      title: "Your competitors moved on your focus situations",
      detail: 'Peerly wrote 4 new articles on "Which pages do answer engines cite" since 3 Nov. And 1 more.',
      details: ['Peerly wrote 4 new articles on "Which pages do answer engines cite" since 3 Nov.', "Your competitors name Bigsuite in 5 articles, and you don't watch it."],
      href: "/admin/brand-kit/map?tab=strategy",
      action: "Review the strategy",
      dismissCheck: true,
    });
    expect(strategyCheckItem(open([{ kind: "named", ref: "Bigsuite", text: "Bigsuite", count: 5, by: [] }]), NOW)).toMatchObject({
      title: "Your competitors name an alternative you don't watch",
      detail: "Your competitors name Bigsuite in 5 articles, and you don't watch it.",
    });
  });

  it("is read only with the switch on, from this brand's approved strategy", async () => {
    const db = new FakeFirestore();
    const record = (tenantId: string, approved: boolean) => ({
      tenantId,
      rev: 2,
      draft: null,
      approved: approved ? { at: "2026-11-02T09:00:00.000Z", focusSituationIds: ["sit_aaaaaa01"] } : null,
      check: moved,
    });
    db.seed("brand_strategy", "bst_ten_A", record("ten_A", true));
    db.seed("brand_strategy", "bst_ten_B", record("ten_B", true));
    expect((await loadReview(ctx, { lifecycle: false, includeContent: false }, db)).items).toEqual([]);
    for (const k of ["BRAND_MAP_ENABLED", "BRAND_STRATEGY_ENABLED", "COMPETITORS_ENABLED", "COMPETITOR_ARTICLES_ENABLED", "STRATEGY_COMPETITORS_ENABLED"]) vi.stubEnv(k, "true");
    expect((await loadReview(ctx, { lifecycle: false, includeContent: false }, db)).items).toEqual([]);
    vi.stubEnv("STRATEGY_CHECK_ENABLED", "true");
    expect((await loadReview(ctx, { lifecycle: false, includeContent: false }, db)).items.map((i) => i.id)).toEqual(["strategy_check:chk_abc123"]);
    // No approved strategy: no row, whatever the record holds.
    db.seed("brand_strategy", "bst_ten_A", record("ten_A", false));
    expect((await loadReview(ctx, { lifecycle: false, includeContent: false }, db)).items).toEqual([]);
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

describe("Vizzy's styles and notes (agent record)", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => resetReviewCountCache());

  const admin: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u_admin", role: "admin" };
  const member: TenantContext = { ...admin, userId: "u_member", role: "member" };

  function world() {
    const db = new FakeFirestore();
    db.seed("tenants", "ten_A", {
      tenantName: "Fernhill Plants",
      rootDomain: "fernhill.example",
      status: "active",
      region: "us",
      allowedOrigins: ["https://fernhill.example"],
      ownerId: "u_owner",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      emailStyleSuggestion: { logoId: null, companyName: null, headerColor: "#2f6b3a", accentColor: "#aa3300", source: "chat", brief: "", notes: [], suggestedBy: "u_admin", suggestedAt: "2026-12-03T10:00:00.000Z" },
    });
    // A draft Vizzy made, listed as today.
    db.seed("lifecycle_journeys", "lcj_1", { tenantId: "ten_A", name: "Spring repotting", authoredBy: "agent", publishedVersion: null, status: "draft" });
    for (const [id, status, source] of [["bn_a0000000", "suggested", "chat"], ["bn_b0000000", "suggested", "chat"], ["bn_c0000000", "suggested", "chat"], ["bn_d0000000", "kept", "chat"], ["bn_e0000000", "suggested", "typed"]]) {
      db.seed("brand_notes", id!, { tenantId: "ten_A", text: "A note we saw.", status, source, createdAt: "2026-12-01T00:00:00.000Z" });
    }
    db.seed("brand_notes", "bn_other000", { tenantId: "ten_B", text: "Another brand's note.", status: "suggested", source: "chat" });
    for (const k of ["LIFECYCLE_ENABLED", "EMAIL_STYLE_ENABLED", "BRAND_NOTES_ENABLED"]) vi.stubEnv(k, "true");
    return db;
  }
  const titles = async (who: TenantContext, db: FakeFirestore) => (await loadReview(who, { lifecycle: true, includeContent: false }, db)).items.map((i) => i.title);

  it("lists every row as today while the switch is off", async () => {
    const db = world();
    expect(await titles(admin, db)).toEqual(["“Spring repotting”"]);
  });

  it("adds the email style and one row for the notes for admins, after today's drafts, read where they live", async () => {
    const db = world();
    vi.stubEnv("AGENT_RECORD_ENABLED", "true");
    const r = await loadReview(admin, { lifecycle: true, includeContent: false }, db);
    expect(r.items.filter((i) => i.kind === "agent_draft")).toEqual([
      expect.objectContaining({ title: "“Spring repotting”" }),
      {
        id: "email_style:2026-12-03T10:00:00.000Z",
        kind: "agent_draft",
        title: "Email style Vizzy suggested",
        detail: "Suggested in a chat on 3 Dec · Nothing changes until an admin saves it on Brand › Email style.",
        href: "/admin/brand-kit/email-style",
        action: "Review",
      },
      {
        id: "brand_notes:suggested",
        kind: "agent_draft",
        title: "3 notes Vizzy suggested",
        detail: "From your chats · Keep the right ones on What we've seen. Articles use only the notes you keep.",
        href: "/admin/brand-kit/notes",
        action: "Review",
      },
    ]);
    // The image style's row shows the same way, with its own switch.
    expect(await titles(admin, db)).not.toContain("Image style Vizzy suggested");
  });

  it("never for members, and the count matches what each sees", async () => {
    const db = world();
    vi.stubEnv("AGENT_RECORD_ENABLED", "true");
    expect(await titles(member, db)).toEqual(["“Spring repotting”"]);
    expect(await countReview(admin, { lifecycle: true, now: 1_000 }, db)).toBe(3);
    expect(await countReview(member, { lifecycle: true, now: 1_000 }, db)).toBe(1);
  });

  it("says 50 or more when the notes it reads fill a page, rather than the page's size as a count", async () => {
    const db = world();
    vi.stubEnv("AGENT_RECORD_ENABLED", "true");
    for (let i = 0; i < 60; i++) db.seed("brand_notes", `bn_many${String(i).padStart(4, "0")}`, { tenantId: "ten_A", text: "A note we saw.", status: "suggested", source: "chat", createdAt: "2026-12-01T00:00:00.000Z" });
    expect(await titles(admin, db)).toContain("50 or more notes Vizzy suggested");
    expect(agentNotesItem(1)?.title).toBe("1 note Vizzy suggested");
    expect(agentNotesItem(0)).toBeNull();
  });

  it("drops a row once its draft is decided, and each row with its own page's switch", async () => {
    const db = world();
    vi.stubEnv("AGENT_RECORD_ENABLED", "true");
    vi.stubEnv("BRAND_NOTES_ENABLED", "false");
    const raw = db.raw("tenants", "ten_A") as Record<string, unknown>;
    db.seed("tenants", "ten_A", { ...raw, emailStyleSuggestion: null });
    expect(await titles(admin, db)).toEqual(["“Spring repotting”"]);
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
      // The product people name, as the approved Review screen writes it.
      title: "Google Analytics needs you",
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
    expect(dataSourceItem(conn({ pausedAt: "2026-11-12T09:00:00.000Z", pausedBy: "usr_admin" }), NOW)).toMatchObject({ title: "Google Analytics is paused", detail: expect.stringContaining("Paused since 12 Nov") });
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
    expect(REVIEW_SECTIONS.data_signal).toEqual({
      title: "What your numbers suggest",
      description: "Searches and pages from Search Console worth an article. Plan one, or dismiss it.",
      from: ["rising_search", "losing_page", "within_reach"],
    });
  });
});

describe("the choices each Review section shows", () => {
  it("names kinds the learning registry has, and null only for failures and health", () => {
    const kinds = new Set(Object.keys(LOOPS));
    const none: string[] = [];
    for (const kind of REVIEW_ORDER) {
      const from = REVIEW_SECTIONS[kind].from;
      if (from === null) {
        none.push(kind);
        continue;
      }
      expect(from.length, kind).toBeGreaterThan(0);
      expect(new Set(from).size, kind).toBe(from.length);
      for (const k of from) expect(kinds.has(k), `${kind} shows ${k}, which src/lib/loops/registry.ts has no line for`).toBe(true);
    }
    expect(none.sort()).toEqual(["connection", "data_source", "failed_post"]);
    // Sections whose rows come from more than one choice name each one.
    expect(REVIEW_SECTIONS.content_refresh.from).toEqual(["blog_refresh", "refresh_due", "freshness_clock"]);
    expect(REVIEW_SECTIONS.next_article.from).toEqual(["next_up", "autopilot", "judge", "seen_notes"]);
    expect(REVIEW_SECTIONS.agent_draft.from).toEqual([
      "canvas.journey",
      "canvas.lifecycle",
      "canvas.journey_style",
      "canvas.invite_wave",
      "canvas.content_plan",
      "autopilot",
      "email_copy",
      "email_hero",
      "canvas.email_style",
      "canvas.image_style",
      "vizzy_chat",
    ]);
    expect(REVIEW_SECTIONS.brand_map.from).toEqual(["brand_map_research", "situations", "situation_questions", "canvas.brand_map", "blog_research", "autopilot_research", "competitor_topics", "judge", "rising_search"]);
    expect(REVIEW_SECTIONS.content_hub.from).toEqual(["content_hub", "blog_write", "ebook", "blog_refresh"]);
  });

  it("names Work's three sections by the rule or the chat behind them, checks and Ready to start after AI lines and Vizzy's tasks before its drafts", () => {
    expect(REVIEW_SECTIONS.work_check.from).toEqual(["work_check_due"]);
    expect(REVIEW_SECTIONS.work_ready.from).toEqual(["work_ready"]);
    expect(REVIEW_SECTIONS.work_suggestion.from).toEqual(["vizzy_chat"]);
    expect(REVIEW_ORDER.slice(0, 3)).toEqual(["ai_line", "work_check", "work_ready"]);
    expect(REVIEW_ORDER.indexOf("work_suggestion")).toBe(REVIEW_ORDER.indexOf("agent_draft") - 1);
    expect(new Set(REVIEW_ORDER).size).toBe(Object.keys(REVIEW_SECTIONS).length);
  });
});

describe("articles due a refresh, in Review", () => {
  const due = (planId: string, state: FreshnessDueItem["state"] = "due"): FreshnessDueItem => ({
    planId,
    workspaceId: "ws1",
    title: `Article ${planId}`,
    url: `https://acme.example/blog/${planId}`,
    state,
    reasons: [
      { kind: "age", detail: "21 days since its last update or check, on a 20-day clock", hard: true },
      { kind: "old_source", detail: "Cites 1 source from 2022 or earlier", hard: false },
    ],
    dueAt: "2026-11-01T00:00:00.000Z",
    clockDays: 20,
    subjectId: null,
  });
  beforeEach(() => {
    resetReviewCountCache();
    vi.stubEnv("BRAND_MAP_ENABLED", "true");
    vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
    vi.stubEnv("BLOG_DATES_ENABLED", "true");
    vi.stubEnv("BLOG_FRESHNESS_ENABLED", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("makes one item per due article, at most ten, leading to its Freshness card", () => {
    const items = refreshItems([due("p1"), due("p2", "soon"), ...Array.from({ length: 12 }, (_, i) => due(`q${i}`))]);
    expect(items).toHaveLength(10);
    expect(items[0]).toEqual({
      id: "content_refresh:p1",
      kind: "content_refresh",
      title: "Due a refresh: Article p1",
      detail: "21 days since its last update or check, on a 20-day clock. Cites 1 source from 2022 or earlier",
      details: ["21 days since its last update or check, on a 20-day clock", "Cites 1 source from 2022 or earlier"],
      href: "/admin/workspace/ws1/create/p1?freshness=1",
      action: "Open article",
    });
    expect(items.some((i) => i.id === "content_refresh:p2")).toBe(false);
  });

  it("reads the brand's own freshness watch, only while freshness is on", async () => {
    const db = new FakeFirestore();
    db.seed("freshness_watch", "fw_ten_A", { tenantId: "ten_A", due: [due("p1"), due("p2", "soon")] });
    db.seed("freshness_watch", "fw_ten_B", { tenantId: "ten_B", due: [due("other")] });
    const kinds = async () => (await loadReview(ctx, { lifecycle: false, includeContent: false }, db)).items.filter((i) => i.kind === "content_refresh").map((i) => i.id);
    expect(await kinds()).toEqual(["content_refresh:p1"]);
    expect(await countReview(ctx, { lifecycle: false, now: 1_000 }, db)).toBe(1);
    vi.stubEnv("BLOG_FRESHNESS_ENABLED", "false");
    expect(await kinds()).toEqual([]);
    expect(REVIEW_ORDER.indexOf("content_refresh")).toBe(REVIEW_ORDER.indexOf("data_signal") + 1);
    expect(REVIEW_SECTIONS.content_refresh.title).toBe("Articles due a refresh");
  });

  it("puts a refresh ready to look at first, once per article (BLOG_REFRESH_ENABLED)", async () => {
    vi.stubEnv("BLOG_REFRESH_ENABLED", "true");
    const db = new FakeFirestore();
    db.seed("freshness_watch", "fw_ten_A", { tenantId: "ten_A", due: [due("p1"), due("p3")] });
    db.seed("article_reviews", "ar_p1", { tenantId: "ten_A", planId: "p1", workspaceId: "ws1", state: "ready", by: "autopilot", proposals: [{}, {}, {}], finishedAt: "2026-11-25T10:00:00.000Z" });
    db.seed("article_reviews", "ar_x", { tenantId: "ten_B", planId: "x", workspaceId: "ws1", state: "ready", by: "person", proposals: [{}], finishedAt: "2026-11-25T10:00:00.000Z" });
    const items = (await loadReview(ctx, { lifecycle: false, includeContent: false }, db)).items.filter((i) => i.kind === "content_refresh");
    expect(items.map((i) => [i.id, i.title])).toEqual([
      ["content_refresh_ready:p1", "Refresh ready: 3 changes to look at"],
      ["content_refresh:p3", "Due a refresh: Article p3"],
    ]);
    expect(items[0]).toMatchObject({ detail: "Article p1 · the autopilot ran the review", action: "Look at changes", href: "/admin/workspace/ws1/create/p1?freshness=1" });
  });
});

describe("Work in Review (WORK_ENABLED)", () => {
  // Made-up Acme with two brands, A and B, in one organisation that Nina owns; Sam is an admin of A
  // who doesn't own it. One fake database stands for the control plane and every region.
  const nina: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "uid_nina", role: "admin" };
  const sam: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "uid_sam", role: "admin" };
  const T = "2026-11-20T09:00:00.000Z";
  const brand = (db: FakeFirestore, id: string, name: string) =>
    db.seed("tenants", id, { tenantName: name, rootDomain: `${id}.example`, ownerId: "uid_nina", status: "active", region: "us", allowedOrigins: [], createdAt: T, updatedAt: T, organisationId: "org_acme", orgPlan: "self_hosted" });
  let n = 0;
  const task = (db: FakeFirestore, over: Record<string, unknown>) => {
    n += 1;
    db.seed("work_tasks", `wt_${"abcdefghijklmnopqrstuvwxyz"[n]!.padStart(20, "a")}`, {
      organisationId: "org_acme",
      brandId: "ten_A",
      addedFrom: "ten_A",
      region: "us",
      ref: n,
      title: `Task ${n}`,
      description: "",
      notes: "",
      status: "todo",
      open: true,
      stage: null,
      mustHave: false,
      links: [],
      blockedBy: [],
      waitingOn: null,
      ideaId: null,
      ideaBrandId: null,
      clipping: null,
      typedLinks: [],
      measure: null,
      origin: { kind: "person", by: "uid_nina" },
      check: null,
      hasCheck: false,
      recent: [],
      closedAt: null,
      createdAt: T,
      updatedAt: T,
      ...over,
    });
  };
  function world() {
    const db = new FakeFirestore();
    brand(db, "ten_A", "Acme");
    brand(db, "ten_B", "Acme Labs");
    db.seed("organisations", "org_acme", { name: "Acme", plan: "self_hosted", planSince: T, brandIds: ["ten_A", "ten_B"], ownerIds: ["uid_nina"], createdBy: "uid_nina", createdAt: T, updatedAt: T });
    task(db, { title: "Register for VAT" });
    task(db, { title: "Look at the sign up page again", status: "in_progress", check: { kind: "date", at: "2026-11-20T08:00:00.000Z", taskId: null, note: "", setBy: "uid_nina", setAt: T, which: null, counted: null }, hasCheck: true });
    task(db, { title: "Acme Labs pricing", brandId: "ten_B", addedFrom: "ten_B" });
    return db;
  }
  beforeEach(() => {
    resetReviewCountCache();
    n = 0;
  });
  afterEach(() => vi.unstubAllEnvs());

  it("adds checks due and tasks ready to start, as Work's view shows them, only while Work is on", async () => {
    const db = world();
    const work = async (ctx: TenantContext) => (await loadReview(ctx, { lifecycle: false, includeContent: false }, db)).items.filter((i) => i.kind.startsWith("work_")).map((i) => `${i.kind} ${i.title}`);
    expect(await work(nina)).toEqual([]);
    vi.stubEnv("WORK_ENABLED", "true");
    expect(await work(nina)).toEqual(["work_check #2 Look at the sign up page again", "work_ready #1 Register for VAT", "work_ready #3 Acme Labs pricing"]);
    // Sam doesn't own the organisation, so in a two brand organisation he sees his brand's only.
    expect(await work(sam)).toEqual(["work_check #2 Look at the sign up page again", "work_ready #1 Register for VAT"]);
    // A system context with no person sees no Work.
    expect(await work(ctx)).toEqual([]);
  });

  it("keys the count by the owner flag too, so an owner's count never reaches an admin who isn't one", async () => {
    vi.stubEnv("WORK_ENABLED", "true");
    const db = world();
    expect(await countReview(nina, { lifecycle: false, now: 1_000 }, db)).toBe(3);
    expect(await countReview(sam, { lifecycle: false, now: 2_000 }, db)).toBe(2);
    task(db, { title: "Another one" });
    // Cached for each, apart.
    expect(await countReview(nina, { lifecycle: false, now: 3_000 }, db)).toBe(3);
    expect(await countReview(sam, { lifecycle: false, now: 3_000 }, db)).toBe(2);
    // A decision forgets every variant for the brand.
    forgetReviewCount("ten_A");
    expect(await countReview(nina, { lifecycle: false, now: 4_000 }, db)).toBe(4);
    expect(await countReview(sam, { lifecycle: false, now: 4_000 }, db)).toBe(3);
  });

  it("names each key: brand, role and, while Work is on, the owner flag", async () => {
    const { countKey } = await import("./summary");
    expect(countKey("ten_A", "admin")).toBe("ten_A|admin");
    expect(countKey("ten_A", "member", true)).toBe("ten_A|member|owner");
    expect(countKey("ten_A", "admin", false)).toBe("ten_A|admin|not_owner");
    expect(countKey("ten_AB", "admin", false).startsWith("ten_A|")).toBe(false);
  });
});

describe("What Vizzy heard about the business (ONBOARDING_ENABLED)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const admin: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u_admin", role: "admin" };
  const member: TenantContext = { ...admin, userId: "u_member", role: "member" };

  async function heard() {
    const { suggestBusinessFact } = await import("@/lib/onboarding/factSuggestions");
    const db = new FakeFirestore();
    const r = await suggestBusinessFact(admin, { kind: "goal", text: "A hundred sign-ups by spring", quote: "We'd love a hundred sign-ups by the spring." }, { db });
    if (!r.ok) throw new Error(r.error);
    return { db, id: r.fact.id };
  }

  it("is listed for admins while the switch is on, opening About your business", async () => {
    const { db, id } = await heard();
    vi.stubEnv("ONBOARDING_ENABLED", "true");
    const r = await loadReview(admin, { lifecycle: false, includeContent: false }, db);
    expect(r.items).toEqual([
      {
        id: `aa:${id}`,
        kind: "business_fact",
        title: "Vizzy heard something new about your business",
        detail: "A hundred sign-ups by spring",
        href: "/admin/account/settings#about",
        action: "Check",
      },
    ]);
    expect(REVIEW_ORDER.indexOf("business_fact")).toBe(REVIEW_ORDER.indexOf("person_suggestion") + 1);
    expect(REVIEW_SECTIONS.business_fact.title).toBe("About your business");
  });

  it("is never listed for a member, nor with the switch off", async () => {
    const { db } = await heard();
    vi.stubEnv("ONBOARDING_ENABLED", "true");
    expect((await loadReview(member, { lifecycle: false, includeContent: false }, db)).items).toEqual([]);
    vi.stubEnv("ONBOARDING_ENABLED", "false");
    expect((await loadReview(admin, { lifecycle: false, includeContent: false }, db)).items).toEqual([]);
  });
});
