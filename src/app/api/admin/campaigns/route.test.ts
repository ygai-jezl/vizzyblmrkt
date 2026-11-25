import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCampaignSettings } from "@/lib/admin/campaignSettings";

// New launch's id: a reserved id derived from the name goes on to createLaunch (which suffixes it);
// only one the admin typed is refused. createLaunch itself is tested in src/lib/admin/createLaunch.test.ts.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const create = vi.hoisted(() => ({ createLaunch: vi.fn() }));
vi.mock("@/lib/admin/createLaunch", async (orig) => ({ ...(await orig<typeof import("@/lib/admin/createLaunch")>()), createLaunch: create.createLaunch }));
vi.mock("@/lib/tenant", async (orig) => ({ ...(await orig<typeof import("@/lib/tenant")>()), forTenant: () => ({ campaigns: {} }) }));

const { POST } = await import("./route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const req = (body: unknown) =>
  new Request("http://localhost/api/admin/campaigns", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const settings = (waitlistName: string) => ({ ...defaultCampaignSettings(), waitlistName });

beforeEach(() => {
  vi.clearAllMocks();
  session.getAdminContext.mockResolvedValue(admin);
  create.createLaunch.mockImplementation(async (_c: unknown, base: string) => (base === "any" || base === "new" ? `${base}-2` : base));
});

describe("POST /api/admin/campaigns", () => {
  it("makes a launch named Any or New with no slug typed, under a suffixed id", async () => {
    for (const name of ["Any", "New"]) {
      const res = await POST(req({ settings: settings(name) }));
      expect(res.status, name).toBe(201);
      expect(await res.json()).toEqual({ ok: true, id: `${name.toLowerCase()}-2` });
    }
    expect(create.createLaunch.mock.calls.map((c) => [c[1], c[3]])).toEqual([
      ["any", { explicit: false }],
      ["new", { explicit: false }],
    ]);
  });

  it("refuses a reserved slug the admin typed", async () => {
    const res = await POST(req({ id: "any", settings: settings("Any") }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_id", message: "that id is reserved" });
    expect(create.createLaunch).not.toHaveBeenCalled();
  });
});
