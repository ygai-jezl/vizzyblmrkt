import { beforeEach, describe, it, expect } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import {
  agentJourneyItem,
  agentLaunchJourneyItem,
  connectionItem,
  contentHubItem,
  countReview,
  failedPostItem,
  loadReview,
  repoResultsItem,
  resetReviewCountCache,
} from "./summary";
import type { RepoAnalysis } from "@/lib/types/repoAnalysis";

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
