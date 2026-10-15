import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";

// The brand's own domains come from its tenant record; here it has one.
vi.mock("@/lib/tenant", async (original) => ({
  ...(await original<typeof import("@/lib/tenant")>()),
  getTenantById: vi.fn(async () => ({ id: "ten_A", rootDomain: "acme.example", allowedOrigins: [] })),
}));

const api = await import("./recordsApi");

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> });

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("the map at any size's admin APIs", () => {
  it("lists nothing until the map has moved, and moving is safe to ask twice", async () => {
    const db = new FakeFirestore();
    const url = new URL("http://localhost/api/admin/brand-kit/map/subjects");
    expect((await json(await api.listSubjectsFromRequest(ctx, url, { db }))).body).toEqual({ moved: false, subjects: [] });
    expect((await json(await api.moveFromRequest(ctx, { db }))).body).toMatchObject({ ok: true, moved: true });
    expect((await json(await api.moveFromRequest(ctx, { db }))).body).toMatchObject({ ok: true, moved: false });
    expect((await json(await api.listSubjectsFromRequest(ctx, url, { db }))).body).toEqual({ moved: true, subjects: [] });
  });

  it("adds a subject (moving the map first), checks its home page, and refuses a stale edit with the subject as it is", async () => {
    const db = new FakeFirestore();
    expect((await api.createSubjectFromRequest(ctx, { name: "" }, { db })).status).toBe(400);
    const elsewhere = await json(await api.createSubjectFromRequest(ctx, { name: "Elsewhere", home: "https://other.example/x" }, { db }));
    expect(elsewhere).toMatchObject({ status: 400, body: { error: "home_not_own_site" } });
    const made = await json(await api.createSubjectFromRequest(ctx, { name: "Share of voice", home: "https://acme.example/sov" }, { db }));
    expect(made).toMatchObject({ status: 200, body: { ok: true, value: { name: "Share of voice", status: "decided" } } });
    const id = (made.body.value as { id: string }).id;
    expect((await json(await api.editSubjectFromRequest(ctx, id, { baseRev: 0, name: "AI share of voice" }, { db }))).status).toBe(200);
    const stale = await json(await api.editSubjectFromRequest(ctx, id, { baseRev: 0, name: "Voice" }, { db }));
    expect(stale).toMatchObject({ status: 409, body: { error: "record_changed", current: { name: "AI share of voice", rev: 1 } } });
    const one = await json(await api.subjectFromRequest(ctx, id, { db }));
    expect(one.body).toMatchObject({ subject: { id, name: "AI share of voice" }, questions: [] });
    expect((await api.subjectFromRequest(ctx, "sub_missing0", { db })).status).toBe(404);
  });

  it("adds questions and groups, and decides proposals many at once", async () => {
    const db = new FakeFirestore();
    const made = await json(await api.createSubjectFromRequest(ctx, { name: "Citations" }, { db }));
    const id = (made.body.value as { id: string }).id;
    const q = await json(await api.addQuestionFromRequest(ctx, id, { text: "Which sources do AI engines cite?", intent: "other" }, { db }));
    expect(q).toMatchObject({ status: 200, body: { value: { subjectId: id }, touched: [id] } });
    const g = await json(await api.createGroupFromRequest(ctx, { name: "Getting cited" }, { db }));
    expect(g.status).toBe(200);
    expect((await json(await api.groupsFromRequest(ctx, { db }))).body).toMatchObject({ groups: [{ name: "Getting cited" }] });
    expect((await api.proposalsFromRequest(ctx, { accept: { subjects: "nope" } }, { db })).status).toBe(400);
    const decided = await json(await api.proposalsFromRequest(ctx, { accept: { subjects: [id] } }, { db }));
    expect(decided).toMatchObject({ status: 200, body: { ok: true, accepted: 0 } });
    expect((await json(await api.subjectNamesFromRequest(ctx, { db }))).body).toEqual({ subjects: [{ id, name: "Citations", groupId: null, status: "decided" }] });
  });
});
