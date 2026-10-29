import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One person, whole (AUDIENCE_ONE_VIEW_ENABLED).
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const whole = vi.hoisted(() => ({ loadWholePerson: vi.fn() }));
vi.mock("@/lib/audience/wholePerson", () => whole);

const { GET } = await import("./route");

const admin = { tenantId: "ten_A", region: "us", source: "session", userId: "u1", role: "admin" };
const call = (id: string) => GET(new Request(`http://localhost/api/admin/audience/everyone/${id}`), { params: Promise.resolve({ personId: id }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
  vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
  whole.loadWholePerson.mockResolvedValue({ id: "ct_1", name: "Ada" });
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/admin/audience/everyone/[personId]", () => {
  it("doesn't exist while the one view is off", async () => {
    vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "false");
    expect((await call("ct_1")).status).toBe(404);
    expect(whole.loadWholePerson).not.toHaveBeenCalled();
  });

  it("needs a session", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await call("ct_1")).status).toBe(401);
  });

  it("finds nobody for an id that can't be one, or isn't this brand's", async () => {
    expect((await call("ct_1..%2F")).status).toBe(404);
    whole.loadWholePerson.mockResolvedValue(null);
    expect((await call("ct_2")).status).toBe(404);
  });

  it("loads the person for the signed-in brand", async () => {
    const res = await call("ct_1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ person: { id: "ct_1", name: "Ada" } });
    expect(whole.loadWholePerson).toHaveBeenCalledWith(admin, "ct_1");
  });
});
