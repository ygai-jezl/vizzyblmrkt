import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Dismiss Vizzy's Email style suggestion: flag, then sign-in, then admin; clears only the
// suggestion the admin saw (by suggestedAt), never the saved style.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const control = vi.hoisted(() => ({ clearTenantEmailStyleSuggestion: vi.fn(async (_id: string, _suggestedAt: string) => true) }));
vi.mock("@/lib/tenant/control", () => control);

const { DELETE } = await import("./route");

const SUGGESTED_AT = "2026-09-27T10:00:00.000Z";
const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const member = { ...admin, userId: "usr_member", role: "member" };
const req = (body?: unknown) =>
  new Request("http://localhost/api/admin/brand-kit/email-style/suggestion", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EMAIL_STYLE_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

describe("DELETE /api/admin/brand-kit/email-style/suggestion", () => {
  it("503s with the flag off, before anything else", async () => {
    vi.stubEnv("EMAIL_STYLE_ENABLED", "");
    expect((await DELETE(req({ suggestedAt: SUGGESTED_AT }))).status).toBe(503);
    expect(session.getAdminContext).not.toHaveBeenCalled();
    expect(control.clearTenantEmailStyleSuggestion).not.toHaveBeenCalled();
  });

  it("401s signed out and 403s for a member", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await DELETE(req({ suggestedAt: SUGGESTED_AT }))).status).toBe(401);
    session.getAdminContext.mockResolvedValue(member);
    expect((await DELETE(req({ suggestedAt: SUGGESTED_AT }))).status).toBe(403);
    expect(control.clearTenantEmailStyleSuggestion).not.toHaveBeenCalled();
  });

  it("400s without the suggestion's suggestedAt", async () => {
    for (const body of [undefined, {}, { suggestedAt: "" }, { suggestedAt: 42 }]) {
      expect((await DELETE(req(body))).status).toBe(400);
    }
    expect(control.clearTenantEmailStyleSuggestion).not.toHaveBeenCalled();
  });

  it("clears it for an admin, by suggestedAt", async () => {
    const res = await DELETE(req({ suggestedAt: SUGGESTED_AT }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cleared: true });
    expect(control.clearTenantEmailStyleSuggestion).toHaveBeenCalledWith("ten_A", SUGGESTED_AT);
  });

  it("says so when a newer suggestion had replaced it", async () => {
    control.clearTenantEmailStyleSuggestion.mockResolvedValueOnce(false);
    const res = await DELETE(req({ suggestedAt: SUGGESTED_AT }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cleared: false });
  });
});
