import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { agentContentContext, agentContentPlan, contentAgentGate } from "./agentApi";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "agent" };
const T = "2026-09-01T00:00:00.000Z";

function world() {
  const db = new FakeFirestore();
  db.seed("workspaces", "ws1", { tenantId: "ten_A", name: "The Weekly Plate", audience: "Busy home cooks", brandVoice: "Warm", createdAt: T });
  db.seed("workspaces", "ws2", { tenantId: "ten_A", name: "Old", archivedAt: T, createdAt: T });
  db.seed("workspaces", "wsB", { tenantId: "ten_B", name: "Not yours", createdAt: T });
  db.seed("workspaces/ws1/content_plans", "p1", {
    id: "p1",
    tenantId: "ten_A",
    workspaceId: "ws1",
    name: "Five 15-minute dinners",
    status: "generating",
    authoredBy: "agent",
    strategy: { objective: "newsletter_signups" },
    scope: {},
    knowledge: {},
    topology: { hubChannel: "newsletter", spokeChannels: ["linkedin"] },
    graph: {
      nodes: [
        { id: "hub", type: "hub", channel: "newsletter", role: "Hub", position: { x: 0, y: 0 }, body: "Hub copy", status: "generated" },
        { id: "s1", type: "spoke", channel: "linkedin", role: "Spoke", position: { x: 1, y: 0 }, body: "", status: "empty" },
      ],
      edges: [],
    },
    createdAt: T,
    updatedAt: T,
  });
  db.seed("workspaces/ws1/templates", "t1", {
    id: "t1", tenantId: "ten_A", workspaceId: "ws1", title: "Hook", body: "x", category: "educate", group: "Hooks", channel: "linkedin", createdAt: T, updatedAt: T,
  });
  return db;
}

afterEach(() => vi.unstubAllEnvs());

describe("content agent API", () => {
  it("is gated by its own flag and the canvas token", () => {
    const req = new Request("https://x.test/api/agent/content/context", { headers: { "x-canvas-context": "nope" } });
    vi.stubEnv("CONTENT_CHAT_AUTHORING_ENABLED", "false");
    expect(contentAgentGate(req)).toMatchObject({ ok: false, result: { status: 503 } });
    vi.stubEnv("CONTENT_CHAT_AUTHORING_ENABLED", "true");
    vi.stubEnv("CANVAS_CONTEXT_SIGNING_KEY", "test-canvas-key");
    expect(contentAgentGate(req)).toMatchObject({ ok: false, result: { status: 401 } });
  });

  it("lists live programmes (the one in view first) with templates and recent plans — no personal data", async () => {
    const r = await agentContentContext(ctx, { workspaceId: "ws1" }, world());
    const body = r.body as { programmes: Array<Record<string, unknown>>; allowed: Record<string, unknown[]> };
    expect(body.programmes.map((p) => p.id)).toEqual(["ws1"]);
    expect(body.programmes[0]).toMatchObject({
      inView: true,
      hasOwnVoice: true,
      templates: { linkedin: 1 },
      recentPlans: [{ id: "p1", pieces: 2, written: 1, approved: 0, authoredBy: "agent" }],
    });
    expect(body.allowed.hubChannels).toEqual(["newsletter", "blog"]);
    expect(body.allowed.spokeChannels).toContain("linkedin");
    expect(JSON.stringify(r.body)).not.toContain("@");
  });

  it("shows one plan's pieces, and nothing from another tenant", async () => {
    const db = world();
    const r = await agentContentPlan(ctx, "ws1", "p1", db);
    expect(r.status).toBe(200);
    expect((r.body as { pieces: Array<{ id: string; status: string }> }).pieces.map((p) => `${p.id}:${p.status}`)).toEqual([
      "hub:generated",
      "s1:empty",
    ]);
    expect((await agentContentPlan(ctx, "wsB", "p1", db)).status).toBe(404);
    expect((await agentContentPlan(ctx, "ws1", "missing", db)).status).toBe(404);
  });
});
