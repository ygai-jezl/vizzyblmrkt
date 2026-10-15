import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tenant = vi.hoisted(() => ({ getTenantById: vi.fn(async () => ({ id: "ten_A", rootDomain: "acme.example", allowedOrigins: [] })) }));
vi.mock("@/lib/tenant", async (importOriginal) => ({ ...(await importOriginal<object>()), getTenantById: tenant.getTenantById }));

import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import type { TenantContext } from "@/lib/tenant/types";
import { BrandMapDecidedSchema } from "@/lib/types/brandMap";
import { dismissBrandMapSuggestions, readBrandMap, saveBrandMap } from "@/lib/brandMap/store";
import { authorBrandMapSuggestions } from "./brandMap";

const admin: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "usr_admin", role: "admin" };
const member: TenantContext = { ...admin, userId: "usr_member", role: "member" };
const author = (input: Record<string, unknown>, ctx = admin, db = new FakeFirestore(), brief = "Add what we talked about") =>
  authorBrandMapSuggestions({ ctx, input, brief }, { db, nowMs: Date.parse("2026-10-15T10:00:00Z") });

beforeEach(() => {
  __resetRateLimitState();
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_CHAT_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("Vizzy's brand map suggestions", () => {
  it("is switched off with its flag, and an admin's", async () => {
    expect(await author({ mode: "add", changes: [{ type: "add_subject", name: "Audits" }] }, member)).toMatchObject({ ok: false, status: 403 });
    vi.stubEnv("BRAND_MAP_CHAT_ENABLED", "false");
    expect(await author({ mode: "add", changes: [{ type: "add_subject", name: "Audits" }] })).toMatchObject({ ok: false, status: 503 });
  });

  it("files what it is asked as suggestions from Vizzy, and says exactly that and that nothing changed", async () => {
    const db = new FakeFirestore();
    await saveBrandMap(admin, { baseRev: 0, decided: BrandMapDecidedSchema.parse({ identity: { name: "Acme" }, subjects: [{ id: "sub_aaaaaaaa", name: "Audits", questions: [] }] }) }, { db });
    const r = await author(
      {
        mode: "add",
        changes: [
          { type: "add_subject", name: "Audits" },
          { type: "add_question", subject: "Audits", text: "What does an audit check?", intent: "definition" },
          { type: "add_name", name: "Rivalco", kind: "alternative" },
        ],
      },
      admin,
      db,
    );
    expect(r).toMatchObject({ ok: true, id: "brand_map", status: "suggested", url: "/admin/brand-kit/map" });
    if (!r.ok) return;
    expect(r.summary).toBe(
      "Filed 2 suggestions for your brand map: Add a question to Audits: “What does an audit check?”; Add Rivalco as an alternative. " +
        "Of what you asked, 1 was already on the map. Nothing in the map has changed: an admin reviews them on Brand › Brand map.",
    );
    expect(r.card).toMatchObject({ kind: "brand_map", cta: "Review and apply", stats: [{ label: "filed", value: 2 }, { label: "waiting", value: 2 }] });
    const read = await readBrandMap(admin, db);
    expect(read.state === "ok" && read.map.rev).toBe(1);
    expect(read.state === "ok" && read.map.suggestions.map((s) => [s.from, s.reason, s.evidence])).toEqual([
      ["vizzy", "Add what we talked about", "asked"],
      ["vizzy", "Add what we talked about", "asked"],
    ]);
  });

  it("never files one dismissed before", async () => {
    const db = new FakeFirestore();
    const first = await author({ mode: "add", changes: [{ type: "add_name", name: "Rivalco", kind: "alternative" }] }, admin, db);
    expect(first.ok).toBe(true);
    const read = await readBrandMap(admin, db);
    await dismissBrandMapSuggestions(admin, read.state === "ok" ? read.map.suggestions.map((s) => s.key) : [], { db });
    const again = await author({ mode: "add", changes: [{ type: "add_name", name: "Rivalco", kind: "alternative" }] }, admin, db);
    expect(again.ok && again.summary).toContain("Filed no suggestions for your brand map. Of what you asked, 1 was dismissed before.");
  });

  it("refuses any link, and writes nothing", async () => {
    const db = new FakeFirestore();
    for (const change of [
      { type: "add_profile", url: "https://www.linkedin.com/company/acme-example" },
      { type: "set_home", name: "Acme Pulse", url: "https://acme.example/pulse" },
      { type: "set_identity", field: "site", value: "https://acme.example" },
      { type: "add_is_not", text: "Not like www.rival.example" },
      { type: "add_name", name: "Pulse", kind: "product", aliases: ["see https://acme.example"] },
    ]) {
      expect(await author({ mode: "add", changes: [change] }, admin, db)).toMatchObject({ ok: false, status: 400, error: "links_not_allowed" });
    }
    // A name that only looks like a domain is a name.
    expect((await author({ mode: "add", changes: [{ type: "add_name", name: "Acme.io", kind: "integration" }] }, admin, db)).ok).toBe(true);
  });

  it("checks each change as the page does", async () => {
    expect(await author({ mode: "add", changes: [{ type: "add_subject", name: "x".repeat(200) }] })).toMatchObject({ ok: false, error: "invalid_input" });
    expect(await author({ mode: "add", changes: [] })).toMatchObject({ ok: false, error: "invalid_input" });
    expect(await author({ mode: "rewrite" })).toMatchObject({ ok: false, error: "invalid_input" });
  });

  it("researches the map with research switched on, and files only suggestions", async () => {
    expect(await author({ mode: "research" })).toMatchObject({ ok: false, status: 503, error: "research_disabled" });
    vi.stubEnv("BRAND_MAP_RESEARCH_ENABLED", "true");
    const db = new FakeFirestore();
    const r = await authorBrandMapSuggestions(
      { ctx: admin, input: { mode: "research" }, brief: "" },
      {
        db,
        research: {
          propose: {
            workspaces: async () => [{ id: "ws1", updatedAt: "2026-10-01" }],
            grounded: (async () => ({ text: "SUBJECT: Share of voice\nQ: What is share of voice? | definition", model: "m", sources: [], supports: [] })) as never,
            modelReady: () => true,
            retrieve: (async () => ({ formatted: "Acme tracks AI answers.", chunks: [] })) as never,
            sitePages: async () => ({ pages: [], repoPaths: [] }),
            fetchHome: async () => null,
            plans: (async () => []) as never,
          },
        },
      },
    );
    expect(r.ok && r.summary).toMatch(/^Research filed \d+ suggestions for your brand map \(.*\)\. Nothing in the map has changed/);
    const read = await readBrandMap(admin, db);
    expect(read.state === "ok" && read.map.rev).toBe(0);
  });
});
