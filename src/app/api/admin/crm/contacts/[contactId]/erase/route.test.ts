import { beforeEach, describe, expect, it, vi } from "vitest";

// Erase (GDPR): admins only, and a person erased, back again and erased again is erased again.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const jobs = vi.hoisted(() => ({ enqueueEmailJob: vi.fn(async () => "enqueued") }));
vi.mock("@/lib/email/jobs", () => jobs);
const contact = vi.hoisted(() => ({ current: null as null | { id: string; campaignIds: string[]; createdAt: string } }));
vi.mock("@/lib/tenant", () => ({ forTenant: () => ({ contacts: { getById: async () => contact.current } }) }));

const { POST } = await import("./route");

const admin = { tenantId: "ten_A", region: "us", source: "session", userId: "u1", role: "admin" };
const call = () => POST(new Request("http://localhost/api/admin/crm/contacts/ct_1/erase", { method: "POST" }), { params: Promise.resolve({ contactId: "ct_1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  session.getAdminContext.mockResolvedValue(admin);
  contact.current = { id: "ct_1", campaignIds: [], createdAt: "2026-10-01T00:00:00.000Z" };
});

describe("POST /api/admin/crm/contacts/[contactId]/erase", () => {
  it("is for admins only", async () => {
    session.getAdminContext.mockResolvedValue({ ...admin, role: "member" });
    expect((await call()).status).toBe(403);
    expect(jobs.enqueueEmailJob).not.toHaveBeenCalled();
  });

  it("queues one erase per record, so the same person back again is erased again", async () => {
    expect((await call()).status).toBe(200);
    contact.current = { ...contact.current!, createdAt: "2026-10-20T00:00:00.000Z" };
    await call();
    const keys = jobs.enqueueEmailJob.mock.calls.map((c) => (c as unknown as [unknown, { dedupeKey: string }])[1].dedupeKey);
    expect(keys).toEqual(["erase:contact:ct_1:2026-10-01T00:00:00.000Z", "erase:contact:ct_1:2026-10-20T00:00:00.000Z"]);
  });
});
