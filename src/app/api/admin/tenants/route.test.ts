import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TenantIsolationError } from "@/lib/tenant/errors";

// New brand: sign-in, a strict parse, then the brand, the creator's membership and (with
// PLANS_ENABLED) an organisation of its own. It never reads or joins the brand the caller is in.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn(), setActiveTenantCookie: vi.fn(async () => {}) }));
vi.mock("@/lib/auth/session", () => session);
const tenant = vi.hoisted(() => ({
  createTenant: vi.fn(async (t: unknown) => t),
  addTenantMember: vi.fn(async () => {}),
  ensureBrandOrganisation: vi.fn(async () => ({ status: "created", organisationId: "org_ten_acme" })),
  getTenantById: vi.fn(async () => null as unknown),
  attachBrandToOrganisation: vi.fn(async () => "moved"),
  getOrganisation: vi.fn(async () => null as unknown),
  organisationIdFor: (id: string) => `org_${id}`,
}));
vi.mock("@/lib/tenant", async () => {
  const errors = await vi.importActual<typeof import("@/lib/tenant/errors")>("@/lib/tenant/errors");
  return { ...tenant, TenantIsolationError: errors.TenantIsolationError };
});
// An empty org_<id> taken up again has its organisation connections disconnected first (Connectors 3).
const orgConnections = vi.hoisted(() => ({ clearOrganisationIdForReuse: vi.fn(async () => 0) }));
vi.mock("@/lib/connectors/organisation", () => orgConnections);

const { POST } = await import("./route");

// The caller sits in the bootstrap brand: a new brand must not join its organisation.
const admin = { tenantId: "ten_home", region: "us", source: "idtoken", userId: "usr_creator", role: "admin" };
const body = { name: "Acme", rootDomain: "https://acme.test/", region: "us" };
const req = (b: unknown = body) =>
  new Request("http://localhost/api/admin/tenants", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(b),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PLANS_ENABLED", "");
  vi.stubEnv("PLANS_NEW_ORGANISATION_PLAN", "");
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/admin/tenants", () => {
  it("401s signed out and 400s on bad input, writing nothing", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await POST(req())).status).toBe(401);
    session.getAdminContext.mockResolvedValue(admin);
    expect((await POST(req({ name: "", rootDomain: "acme.test", region: "us" }))).status).toBe(400);
    expect((await POST(req({ ...body, region: "mars" }))).status).toBe(400);
    expect(tenant.createTenant).not.toHaveBeenCalled();
    expect(tenant.ensureBrandOrganisation).not.toHaveBeenCalled();
  });

  it("with plans off, makes the brand with no organisation, still writing the unread billingTier", async () => {
    const res = await POST(req());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, id: "ten_acme" });
    const made = tenant.createTenant.mock.calls[0]![0] as Record<string, unknown>;
    expect(made).toMatchObject({ id: "ten_acme", tenantName: "Acme", rootDomain: "acme.test", region: "us", allowedOrigins: [], ownerId: "usr_creator" });
    // A build from before plans requires billingTier, so a rollback must still read this brand.
    expect(made.billingTier).toBe("mvp_free");
    expect(tenant.addTenantMember).toHaveBeenCalledWith("usr_creator", "ten_acme", "admin");
    expect(session.setActiveTenantCookie).toHaveBeenCalledWith("ten_acme");
    expect(tenant.ensureBrandOrganisation).not.toHaveBeenCalled();
    expect(tenant.getTenantById).not.toHaveBeenCalled();
  });

  it.each([
    ["unset", "", "self_hosted"],
    ["unknown", "platinum", "self_hosted"],
    ["free", "free", "free"],
  ])("with plans on and the setting %s, starts its own organisation on %s with the creator as owner", async (_label, setting, plan) => {
    vi.stubEnv("PLANS_ENABLED", "true");
    vi.stubEnv("PLANS_NEW_ORGANISATION_PLAN", setting);
    expect((await POST(req())).status).toBe(201);
    expect(tenant.ensureBrandOrganisation).toHaveBeenCalledTimes(1);
    expect(tenant.ensureBrandOrganisation).toHaveBeenCalledWith("ten_acme", { plan, createdBy: "usr_creator", ownerIds: ["usr_creator"] });
    // No read of the brand the caller is in, and no join.
    expect(tenant.getTenantById).not.toHaveBeenCalled();
    expect(tenant.attachBrandToOrganisation).not.toHaveBeenCalled();
    expect(tenant.createTenant.mock.calls[0]![0]).toHaveProperty("billingTier", "mvp_free");
  });

  it("on a retry of the caller's own brand, re-ensures membership and the organisation without moving it", async () => {
    vi.stubEnv("PLANS_ENABLED", "true");
    tenant.createTenant.mockRejectedValueOnce(new TenantIsolationError("tenant ten_acme already exists"));
    tenant.getTenantById.mockResolvedValueOnce({ id: "ten_acme", ownerId: "usr_creator" });
    tenant.ensureBrandOrganisation.mockResolvedValueOnce({ status: "exists", organisationId: "org_ten_acme" });
    const res = await POST(req());
    expect(res.status).toBe(201);
    expect(tenant.getTenantById).toHaveBeenCalledWith("ten_acme");
    expect(tenant.getTenantById).not.toHaveBeenCalledWith("ten_home");
    expect(tenant.addTenantMember).toHaveBeenCalledWith("usr_creator", "ten_acme", "admin");
    expect(tenant.ensureBrandOrganisation).toHaveBeenCalledWith("ten_acme", { plan: "self_hosted", createdBy: "usr_creator", ownerIds: ["usr_creator"] });
    expect(tenant.attachBrandToOrganisation).not.toHaveBeenCalled();
  });

  it("409s when the name belongs to someone else's brand, with no organisation", async () => {
    vi.stubEnv("PLANS_ENABLED", "true");
    tenant.createTenant.mockRejectedValueOnce(new TenantIsolationError("tenant ten_acme already exists"));
    tenant.getTenantById.mockResolvedValueOnce({ id: "ten_acme", ownerId: "usr_other" });
    expect((await POST(req())).status).toBe(409);
    expect(tenant.addTenantMember).not.toHaveBeenCalled();
    expect(tenant.ensureBrandOrganisation).not.toHaveBeenCalled();
  });

  it.each([
    ["throws", () => tenant.ensureBrandOrganisation.mockRejectedValueOnce(Object.assign(new Error("deadline for jo@example.com"), { code: 4 }))],
    ["reports a conflict", () => tenant.ensureBrandOrganisation.mockResolvedValueOnce({ status: "conflict", organisationId: "org_ten_acme" })],
  ])("still makes the brand (201) when the link %s, logging a code only", async (_label, arrange) => {
    vi.stubEnv("PLANS_ENABLED", "true");
    arrange();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(req());
    expect(res.status).toBe(201);
    expect(session.setActiveTenantCookie).toHaveBeenCalledWith("ten_acme");
    expect(errors).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(errors.mock.calls[0]);
    expect(logged).toContain("organisation_link_failed");
    expect(logged).not.toContain("example.com");
    errors.mockRestore();
  });

  it("disconnects what an empty org_<id> still holds before the new brand takes it up, and leaves a fresh one alone", async () => {
    vi.stubEnv("PLANS_ENABLED", "true");
    expect((await POST(req())).status).toBe(201);
    expect(orgConnections.clearOrganisationIdForReuse).not.toHaveBeenCalled();
    tenant.getOrganisation.mockResolvedValueOnce({ id: "org_ten_acme", brandIds: [], ownerIds: ["usr_old"] });
    expect((await POST(req())).status).toBe(201);
    expect(orgConnections.clearOrganisationIdForReuse).toHaveBeenCalledWith("org_ten_acme", "usr_creator");
    expect(orgConnections.clearOrganisationIdForReuse.mock.invocationCallOrder[0]!).toBeLessThan(tenant.ensureBrandOrganisation.mock.invocationCallOrder.at(-1)!);
  });
});
