import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { markdownToText } from "@/lib/search/text";
import { getContentPlan, updateContentPlan } from "@/lib/tenant/workspaceContent";
import type { ContentPlan } from "@/lib/types/contentPlan";
import { createRun, getRun } from "@/lib/autopilot/runs";
import { setArticleLive } from "./live";
import { sampleHub, samplePlan } from "./testing/samplePlan";
import { SAMPLE_ARTICLE } from "./testing/sampleArticle";

const keepApprovedSeen = vi.hoisted(() => vi.fn(async () => true));
vi.mock("./hubActions", async (importOriginal) => ({ ...(await importOriginal<typeof import("./hubActions")>()), keepApprovedSeen }));

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const PLANS = "workspaces/ws1/content_plans";
const now = () => new Date("2026-11-21T10:00:00.000Z");
const TITLE = "What is AI search visibility monitoring?";
const onSite = async () => ({ title: "AI Visibility Explained | Acme", h1: TITLE, text: markdownToText(SAMPLE_ARTICLE) });

function seed(db: FakeFirestore, plan: ContentPlan): ContentPlan {
  db.seed(PLANS, plan.id, plan);
  return plan;
}
const stored = async (db: FakeFirestore) => (await getContentPlan(ctx, "ws1", "plan_1", db))!;
const hubOf = (plan: ContentPlan) => plan.graph.nodes.find((n) => n.type === "hub")!;

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
  vi.stubEnv("BLOG_LIVE_WATCH_ENABLED", "true");
  keepApprovedSeen.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("found live approves the article", () => {
  it("a check that finds it approves it, with what a person's approval does", async () => {
    const db = new FakeFirestore();
    const plan = seed(db, samplePlan());
    const r = await setArticleLive(ctx, { workspaceId: "ws1", plan, nodeId: "hub", action: "check" }, { db, now, fetchPage: onSite });
    expect(r.ok && r.node).toMatchObject({ status: "approved", blog: { live: { by: "check", approvedOnLive: true, textShare: 1 } } });
    expect(hubOf(await stored(db)).status).toBe("approved");
    expect(db.raw("brand_map_pages", "p_plan_1")).toMatchObject({ state: "live" });
    expect(keepApprovedSeen).toHaveBeenCalledTimes(1);
  });

  it("a person saying it's live approves it too, and keeps their word as theirs", async () => {
    const db = new FakeFirestore();
    const plan = seed(db, samplePlan());
    const r = await setArticleLive(ctx, { workspaceId: "ws1", plan, nodeId: "hub", action: "mark" }, { db, now });
    expect(r.ok && r.node).toMatchObject({ status: "approved", blog: { live: { by: "operator", approvedOnLive: true } } });
  });

  it("'Not live' takes the mark away, never the approval", async () => {
    const db = new FakeFirestore();
    let plan = seed(db, samplePlan());
    await setArticleLive(ctx, { workspaceId: "ws1", plan, nodeId: "hub", action: "mark" }, { db, now });
    plan = await stored(db);
    const r = await setArticleLive(ctx, { workspaceId: "ws1", plan, nodeId: "hub", action: "clear" }, { db, now });
    expect(r.ok && r.node).toMatchObject({ status: "approved", blog: { live: null } });
  });

  it("an article already approved stays as it was, and a check again keeps the approval it made", async () => {
    const db = new FakeFirestore();
    let plan = seed(db, samplePlan({}, sampleHub({ status: "approved" })));
    const r = await setArticleLive(ctx, { workspaceId: "ws1", plan, nodeId: "hub", action: "check" }, { db, now, fetchPage: onSite });
    expect(r.ok && r.node.blog?.live).not.toHaveProperty("approvedOnLive");
    expect(keepApprovedSeen).not.toHaveBeenCalled();

    const db2 = new FakeFirestore();
    plan = seed(db2, samplePlan());
    await setArticleLive(ctx, { workspaceId: "ws1", plan, nodeId: "hub", action: "mark" }, { db: db2, now });
    const again = await setArticleLive(ctx, { workspaceId: "ws1", plan: await stored(db2), nodeId: "hub", action: "check" }, { db: db2, now, fetchPage: onSite });
    expect(again.ok && again.node.blog?.live).toMatchObject({ by: "check", approvedOnLive: true });
  });

  it("marks only, with no approval, an article autopilot is writing, one not written yet, or an archived plan", async () => {
    for (const plan of [
      samplePlan({ autopilot: { runId: "run_x", state: "working", at: "" } }),
      samplePlan({}, sampleHub({ status: "generating" })),
      samplePlan({}, sampleHub({ status: "error" })),
      samplePlan({ status: "archived" }),
    ]) {
      const db = new FakeFirestore();
      seed(db, plan);
      const r = await setArticleLive(ctx, { workspaceId: "ws1", plan, nodeId: "hub", action: "mark" }, { db, now });
      expect(r.ok && r.node.status).toBe(hubOf(plan).status);
      expect(r.ok && r.node.blog?.live).toMatchObject({ by: "operator" });
      expect(r.ok && r.node.blog?.live).not.toHaveProperty("approvedOnLive");
    }
    expect(keepApprovedSeen).not.toHaveBeenCalled();
  });

  it("decides inside the write: autopilot taking the plan back after the page was read means no approval", async () => {
    const db = new FakeFirestore();
    const plan = seed(db, samplePlan());
    await updateContentPlan(ctx, "ws1", "plan_1", { autopilot: { runId: "run_x", state: "working", at: "" } }, db);
    // The route read the plan before autopilot locked it.
    const r = await setArticleLive(ctx, { workspaceId: "ws1", plan, nodeId: "hub", action: "check" }, { db, now, fetchPage: onSite });
    expect(r.ok && r.node.status).toBe("generated");
  });

  it("closes an autopilot draft's question rows", async () => {
    const db = new FakeFirestore();
    const run = await createRun(ctx, { id: "run_aaaaaaaaaaaaaaaaaaaaaaaa", mode: "draft", trigger: "schedule", step: "done", question: null }, { db });
    await forTenant(ctx, db).autopilotRuns.update(run.id, { planId: "plan_1", workspaceId: "ws1", askedIds: ["note_1"] });
    const plan = seed(db, samplePlan({ autopilot: { runId: run.id, state: "done", at: "" } }));
    await setArticleLive(ctx, { workspaceId: "ws1", plan, nodeId: "hub", action: "check" }, { db, now, fetchPage: onSite });
    expect(await getRun(ctx, run.id, { db })).toMatchObject({ askedIds: [], answersIn: false });
  });

  it("with the switch off, a person's word marks it live and approves nothing", async () => {
    vi.stubEnv("BLOG_LIVE_WATCH_ENABLED", "");
    const db = new FakeFirestore();
    const plan = seed(db, samplePlan());
    const r = await setArticleLive(ctx, { workspaceId: "ws1", plan, nodeId: "hub", action: "mark" }, { db, now });
    expect(r.ok && r.node.status).toBe("generated");
  });
});

describe("a canvas opened before it was found live", () => {
  async function approvedOnLive(db: FakeFirestore) {
    const plan = seed(db, samplePlan());
    await setArticleLive(ctx, { workspaceId: "ws1", plan, nodeId: "hub", action: "check" }, { db, now, fetchPage: onSite });
    return plan; // the canvas's older copy: hub "generated", same text
  }

  it("keeps the approval when the old copy is saved with the same text", async () => {
    const db = new FakeFirestore();
    const old = await approvedOnLive(db);
    await updateContentPlan(ctx, "ws1", "plan_1", { graph: old.graph }, db);
    expect(hubOf(await stored(db))).toMatchObject({ status: "approved", blog: { live: { approvedOnLive: true } } });
  });

  it("an Edit mode save that changed nothing keeps it too", async () => {
    const db = new FakeFirestore();
    await approvedOnLive(db);
    const now2 = await stored(db);
    const graph = { ...now2.graph, nodes: now2.graph.nodes.map((n) => ({ ...n, status: "generated" as const })) };
    await updateContentPlan(ctx, "ws1", "plan_1", { graph }, db);
    expect(hubOf(await stored(db)).status).toBe("approved");
  });

  it("a changed text takes the approval back, as typing does", async () => {
    const db = new FakeFirestore();
    const old = await approvedOnLive(db);
    const graph = { ...old.graph, nodes: old.graph.nodes.map((n) => ({ ...n, body: `${n.body}\n\nOne more line.` })) };
    await updateContentPlan(ctx, "ws1", "plan_1", { graph }, db);
    expect(hubOf(await stored(db)).status).toBe("generated");
  });

  it("an approval a person made keeps today's rule (their own canvas knows it)", async () => {
    const db = new FakeFirestore();
    seed(db, samplePlan({}, sampleHub({ status: "approved" })));
    const old = samplePlan();
    await updateContentPlan(ctx, "ws1", "plan_1", { graph: old.graph }, db);
    expect(hubOf(await stored(db)).status).toBe("generated");
  });
});
