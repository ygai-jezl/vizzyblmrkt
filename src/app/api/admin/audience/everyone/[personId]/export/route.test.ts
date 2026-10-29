import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Export one whole person (AUDIENCE_ONE_VIEW_ENABLED): admins only.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const exporter = vi.hoisted(() => ({ exportWholePerson: vi.fn(async () => ({ found: true, document: { format: "yougrow.whole-person" } })) }));
vi.mock("@/lib/audience/personExport", () => exporter);

const { GET } = await import("./route");

const admin = { tenantId: "ten_A", region: "us", source: "session", userId: "u1", role: "admin" };
const call = (id = "ct_1") => GET(new Request(`http://localhost/api/admin/audience/everyone/${id}/export`), { params: Promise.resolve({ personId: id }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
  vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/admin/audience/everyone/[personId]/export", () => {
  it("doesn't exist while the one view is off", async () => {
    vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "false");
    expect((await call()).status).toBe(404);
  });

  it("is for admins only", async () => {
    session.getAdminContext.mockResolvedValue({ ...admin, role: "member" });
    expect((await call()).status).toBe(403);
    expect(exporter.exportWholePerson).not.toHaveBeenCalled();
  });

  it("downloads a file named by our id for them", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="ct_1.person.json"');
    exporter.exportWholePerson.mockResolvedValueOnce({ found: false } as never);
    expect((await call("ct_2")).status).toBe(404);
  });
});
