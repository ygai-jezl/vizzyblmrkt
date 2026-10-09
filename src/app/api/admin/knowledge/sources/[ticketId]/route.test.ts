import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Marking a source as one to cite re-stamps its chunks first, then the source itself.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tickets = vi.hoisted(() => ({ getById: vi.fn(), update: vi.fn(async () => {}), delete: vi.fn(async () => {}) }));
const tenant = vi.hoisted(() => ({
  forTenant: vi.fn(),
  setKnowledgeTags: vi.fn(async () => 7),
  deleteOwnerKnowledge: vi.fn(async () => 0),
}));
vi.mock("@/lib/tenant", () => tenant);

const { PATCH } = await import("./route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const source = (over: Record<string, unknown> = {}) => ({
  id: "tkt_1",
  tenantId: "ten_A",
  ownerKind: "workspace",
  ownerId: "ws1",
  source: "docs_url",
  sourceUri: "https://research.example.org/report",
  tags: ["pricing"],
  status: "done",
  ...over,
});
const params = { params: Promise.resolve({ ticketId: "tkt_1" }) };
const req = (body: unknown) =>
  new Request("http://localhost/api/admin/knowledge/sources/tkt_1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CREATE_BLOG_CITE_SOURCES_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
  tenant.forTenant.mockReturnValue({ ingestionTickets: tickets });
  tickets.getById.mockResolvedValue(source());
});
afterEach(() => vi.unstubAllEnvs());

describe("PATCH /api/admin/knowledge/sources/[ticketId]", () => {
  it("marks a source as one to cite: its chunks first, then the source, and its other tags stay", async () => {
    const res = await PATCH(req({ cite: true }), params);
    expect(res.status).toBe(200);
    expect(tenant.setKnowledgeTags).toHaveBeenCalledWith(admin, "workspace", "ws1", { ticketId: "tkt_1", tags: ["cite", "pricing"] });
    expect(tickets.update).toHaveBeenCalledWith("tkt_1", { tags: ["cite", "pricing"] });
    expect(tenant.setKnowledgeTags.mock.invocationCallOrder[0]).toBeLessThan(tickets.update.mock.invocationCallOrder[0]!);
    expect(await res.json()).toMatchObject({ updatedChunks: 7, ticket: { tags: ["cite", "pricing"] } });
  });

  it("takes the mark away again", async () => {
    tickets.getById.mockResolvedValue(source({ tags: ["cite", "pricing"] }));
    const res = await PATCH(req({ cite: false }), params);
    expect(res.status).toBe(200);
    expect(tickets.update).toHaveBeenCalledWith("tkt_1", { tags: ["pricing"] });
  });

  it("leaves the source as it is when the chunks could not be re-stamped", async () => {
    tenant.setKnowledgeTags.mockRejectedValueOnce(new Error("unavailable"));
    await expect(PATCH(req({ cite: true }), params)).rejects.toThrow("unavailable");
    expect(tickets.update).not.toHaveBeenCalled();
  });

  it("writes nothing when the source already is what was asked", async () => {
    const res = await PATCH(req({ cite: false }), params);
    expect(res.status).toBe(200);
    expect(tenant.setKnowledgeTags).not.toHaveBeenCalled();
    expect(tickets.update).not.toHaveBeenCalled();
  });

  it("refuses a code repo, a source still being read, and a request that doesn't say", async () => {
    tickets.getById.mockResolvedValue(source({ source: "github" }));
    expect((await PATCH(req({ cite: true }), params)).status).toBe(409);
    tickets.getById.mockResolvedValue(source({ status: "embedding" }));
    const busy = await PATCH(req({ cite: true }), params);
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: "source_busy" });
    expect((await PATCH(req({}), params)).status).toBe(400);
    expect(tenant.setKnowledgeTags).not.toHaveBeenCalled();
  });

  it("answers 404 for a source that isn't this tenant's, and 401 with no session", async () => {
    tickets.getById.mockResolvedValue(null);
    expect((await PATCH(req({ cite: true }), params)).status).toBe(404);
    session.getAdminContext.mockResolvedValue(null);
    expect((await PATCH(req({ cite: true }), params)).status).toBe(401);
  });

  it("is switched off until the flag is on", async () => {
    vi.stubEnv("CREATE_BLOG_CITE_SOURCES_ENABLED", "false");
    expect((await PATCH(req({ cite: true }), params)).status).toBe(503);
    expect(tickets.getById).not.toHaveBeenCalled();
  });
});
