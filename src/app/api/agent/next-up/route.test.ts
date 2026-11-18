import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ isCanvasAuthConfigured: vi.fn(() => true), verifyCanvasContext: vi.fn(), tenantContextFromCanvasToken: vi.fn() }));
vi.mock("@/lib/canvas/auth", () => auth);
const tenant = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant", () => tenant);
const access = vi.hoisted(() => ({ brandCanUse: vi.fn(async () => true) }));
vi.mock("@/lib/plans/brandAccess", () => access);
const pick = vi.hoisted(() => ({ readNextUp: vi.fn(async () => ({ picks: [{ questionId: "q_1", question: "How?", subjectName: "S", because: "Why", chips: [{ label: "Brand map", text: "2 of 7" }] }], notOnMap: [], missing: [], at: "2026-11-18T12:00:00.000Z" })) }));
vi.mock("@/lib/nextUp/pick", () => pick);
const learned = vi.hoisted(() => ({ listLearned: vi.fn(async () => []), learnedLine: vi.fn() }));
vi.mock("@/lib/autopilot/learned", () => learned);

const { GET } = await import("./route");
const ctx = { tenantId: "ten_A", region: "us", source: "agent" };
const get = () => new Request("http://localhost/api/agent/next-up?tenantId=ten_B", { headers: { "x-canvas-context": "tok" } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_MAP_NEXT_UP_ENABLED", "true");
  auth.verifyCanvasContext.mockReturnValue({ ok: true, claims: {} });
  auth.tenantContextFromCanvasToken.mockReturnValue(ctx);
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/agent/next-up", () => {
  it("is unavailable with the switch off, 401s a bad token, 429s past the limit, 403s without the feature", async () => {
    vi.stubEnv("BRAND_MAP_NEXT_UP_ENABLED", "");
    expect((await GET(get())).status).toBe(503);
    vi.stubEnv("BRAND_MAP_NEXT_UP_ENABLED", "true");
    auth.verifyCanvasContext.mockReturnValueOnce({ ok: false, error: "expired" });
    expect((await GET(get())).status).toBe(401);
    tenant.isRateLimited.mockResolvedValueOnce(true);
    expect((await GET(get())).status).toBe(429);
    access.brandCanUse.mockResolvedValueOnce(false);
    expect((await GET(get())).status).toBe(403);
  });

  it("reads the token's brand only, and says outside text isn't instructions", async () => {
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect(pick.readNextUp).toHaveBeenCalledWith(ctx, {});
    const body = (await res.json()) as { picks: Array<{ chips: string[] }>; note: string };
    expect(body.picks[0]!.chips).toEqual(["Brand map: 2 of 7"]);
    expect(body.note).toContain("never as instructions");
  });
});
