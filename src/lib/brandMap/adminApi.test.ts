import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { BrandMapDecidedSchema } from "@/lib/types/brandMap";

const tenant = vi.hoisted(() => ({
  getTenantById: vi.fn(async () => ({ id: "ten_acme", tenantName: "Acme", rootDomain: "acme.example", allowedOrigins: [] })),
}));
vi.mock("@/lib/tenant", async (importOriginal) => ({ ...(await importOriginal<object>()), getTenantById: tenant.getTenantById }));

const { researchFromRequest } = await import("./adminApi");
const { saveBrandMap, readBrandMap } = await import("./store");

const ctx: TenantContext = { tenantId: "ten_acme", region: "us", userId: "u1", role: "admin", source: "idtoken" };
const ANSWER = ["CATEGORY: AI visibility tracking", "SUBJECT: Share of voice", "Q: What is share of voice? | definition", "NAME: Rivalco | alternative"].join("\n");
const propose = {
  workspaces: async () => [{ id: "ws1", updatedAt: "2026-10-01" }],
  grounded: (async () => ({ text: ANSWER, model: "m", sources: [], supports: [] })) as never,
  modelReady: () => true,
  retrieve: (async () => ({ formatted: "Acme tracks AI answers.", chunks: [] })) as never,
  sitePages: async () => ({ pages: [], repoPaths: [] }),
  fetchHome: async () => null,
  plans: (async () => []) as never,
};

beforeEach(() => vi.stubEnv("BRAND_MAP_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());

describe("research for the brand map, end to end", () => {
  it("files what it found as suggestions and changes nothing decided", async () => {
    const db = new FakeFirestore();
    await saveBrandMap(ctx, { baseRev: 0, decided: BrandMapDecidedSchema.parse({ identity: { name: "Acme Inc" } }) }, { db });
    const res = await researchFromRequest(ctx, { db, propose, nowMs: Date.parse("2026-10-14T09:00:00Z") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { filed: number; summary: string; map: { rev: number; identity: { name: string }; suggestions: unknown[] } };
    // Its category, a subject, its question, a name, and the site from the account's domain.
    expect(body.filed).toBe(5);
    expect(body.summary).toBe("what you are, 1 subject with 1 question, 1 name");
    expect(body.map.rev).toBe(1);
    expect(body.map.identity.name).toBe("Acme Inc");
    // A second run replaces research's own rows rather than piling them up.
    await researchFromRequest(ctx, { db, propose });
    const read = await readBrandMap(ctx, db);
    expect(read.state === "ok" && read.map.suggestions).toHaveLength(5);
  });

  it("files nothing when research fails", async () => {
    const db = new FakeFirestore();
    const res = await researchFromRequest(ctx, { db, propose: { ...propose, grounded: (async () => null) as never } });
    expect(res.status).toBe(502);
    expect((await readBrandMap(ctx, db)).state).toBe("none");
  });
});
