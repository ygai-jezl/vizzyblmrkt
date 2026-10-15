import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { signCanvasContext } from "@/lib/canvas/auth";
import { BrandMapDecidedSchema } from "@/lib/types/brandMap";
import { agentBrandMap, brandMapAgentGate } from "./agentApi";
import { fileBrandMapSuggestions, saveBrandMap } from "./store";

const admin: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "usr_admin", role: "admin" };
const req = (token?: string) => new Request("https://app.example.com/api/agent/brand-map", { headers: token ? { "x-canvas-context": token } : {} });
const DECIDED = BrandMapDecidedSchema.parse({
  identity: { name: "Acme", category: "AI visibility tracking", site: "https://acme.example" },
  subjects: [{ id: "sub_aaaaaaaa", name: "Share of voice", questions: [{ id: "q_aaaaaaaa", text: "What is share of voice?", intent: "definition" }] }],
  names: [{ id: "n_aaaaaaaa", name: "Rivalco", kind: "alternative" }],
});

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_CHAT_ENABLED", "true");
  vi.stubEnv("CANVAS_CONTEXT_SIGNING_KEY", "test-only-canvas-key");
});
afterEach(() => vi.unstubAllEnvs());

describe("Vizzy's read of the brand map", () => {
  it("is gated by its switch and the signed token", () => {
    expect(brandMapAgentGate(req())).toMatchObject({ ok: false, result: { status: 401 } });
    expect(brandMapAgentGate(req("forged.token"))).toMatchObject({ ok: false, result: { status: 401 } });
    expect(brandMapAgentGate(req(signCanvasContext(admin)))).toMatchObject({ ok: true, ctx: { tenantId: "ten_A" } });
    vi.stubEnv("BRAND_MAP_CHAT_ENABLED", "false");
    expect(brandMapAgentGate(req(signCanvasContext(admin)))).toMatchObject({ ok: false, result: { status: 503 } });
  });

  it("says there is no map yet", async () => {
    expect((await agentBrandMap(admin, new FakeFirestore())).body).toMatchObject({ map: null });
  });

  it("reads what is decided and what waits, never who asked", async () => {
    const db = new FakeFirestore();
    await saveBrandMap(admin, { baseRev: 0, decided: DECIDED }, { db });
    await fileBrandMapSuggestions(admin, { from: "vizzy", items: [{ change: { type: "add_subject", name: "Audits" }, reason: "Asked in chat" }] }, { db });
    const r = await agentBrandMap(admin, db);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      map: {
        rev: 1,
        saved: true,
        identity: { name: "Acme", category: "AI visibility tracking", profiles: [] },
        subjects: [{ id: "sub_aaaaaaaa", questions: [{ id: "q_aaaaaaaa", text: "What is share of voice?" }] }],
        names: [{ id: "n_aaaaaaaa", name: "Rivalco", kind: "alternative" }],
      },
      suggestions: { waiting: 1, latest: [{ change: "Add a subject: “Audits”", from: "vizzy", reason: "Asked in chat" }] },
      statesKnown: false,
    });
    expect(JSON.stringify(r.body)).not.toContain("usr_admin");
  });

  it("says which questions are answered, with the pages switch on", async () => {
    vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
    const db = new FakeFirestore();
    await saveBrandMap(admin, { baseRev: 0, decided: DECIDED }, { db });
    db.seed("brand_map_pages", "p_a", { tenantId: "ten_A", kind: "article", title: "Share of voice, explained", url: "https://acme.example/blog/sov", primaryRef: "q_aaaaaaaa", state: "live" });
    const r = await agentBrandMap(admin, db);
    expect(r.body).toMatchObject({
      statesKnown: true,
      map: { subjects: [{ questions: [{ state: "answered", answeredBy: { title: "Share of voice, explained", url: "https://acme.example/blog/sov" } }] }] },
    });
  });
});
