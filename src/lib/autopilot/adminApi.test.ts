import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { forgetLearned, readLearned, type AutopilotAdminDeps } from "./adminApi";
import { addLearned } from "./learned";

const MEMBER: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "member" };
const ADMIN: TenantContext = { ...MEMBER, role: "admin" };
const OTHER: TenantContext = { ...ADMIN, tenantId: "ten_B" };

const deps = (): AutopilotAdminDeps & { db: FakeFirestore } => ({ db: new FakeFirestore(), canUse: async () => true });

beforeEach(() => vi.stubEnv("BRAND_MAP_NEXT_UP_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());

describe("the Learned list API", () => {
  it("is off with the switch off, and for a brand without next_up", async () => {
    const d = deps();
    vi.stubEnv("BRAND_MAP_NEXT_UP_ENABLED", "false");
    expect(await readLearned(MEMBER, d)).toEqual({ status: 503, body: { error: "unavailable" } });
    vi.stubEnv("BRAND_MAP_NEXT_UP_ENABLED", "true");
    expect(await readLearned(MEMBER, { ...d, canUse: async () => false })).toEqual({ status: 403, body: { error: "not_included" } });
  });

  it("lets members read it and only admins forget, one entry or all, for their own brand", async () => {
    const d = deps();
    const e = await addLearned(ADMIN, { kind: "skipped_pick", text: "What does ChatGPT cost?", reason: "not ours", from: "person" }, d);
    const read = await readLearned(MEMBER, d);
    expect(read).toMatchObject({ status: 200, body: { learned: [{ id: e!.id, line: 'Skipped as a next article: "What does ChatGPT cost?", because not ours' }] } });
    expect(await forgetLearned(MEMBER, { id: e!.id }, d)).toEqual({ status: 403, body: { error: "forbidden" } });
    expect(await forgetLearned(ADMIN, { id: "nope" }, d)).toEqual({ status: 400, body: { error: "invalid_input" } });
    expect(await forgetLearned(OTHER, { id: e!.id }, d)).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await forgetLearned(ADMIN, { id: e!.id }, d)).toEqual({ status: 200, body: { removed: 1 } });
    await addLearned(ADMIN, { kind: "moved", text: "Two", from: "person" }, d);
    expect(await forgetLearned(ADMIN, { all: true }, d)).toEqual({ status: 200, body: { removed: 1 } });
  });
});
