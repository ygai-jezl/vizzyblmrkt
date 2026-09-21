import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { signUnsubscribeToken, signUnsubscribeTokenV2 } from "@/lib/email/unsubscribeToken";

const applyUnsubscribe = vi.fn(async () => ({ ok: true, tenant: null }));
const applyLifecycleUnsubscribe = vi.fn(async () => ({ ok: true, tenant: null }));
vi.mock("@/lib/email/unsubscribeAction", () => ({
  applyUnsubscribe: (...a: unknown[]) => applyUnsubscribe(...(a as [])),
  applyLifecycleUnsubscribe: (...a: unknown[]) => applyLifecycleUnsubscribe(...(a as [])),
}));

const { POST } = await import("./route");

const ORIGIN = "https://mk.test";
const v2 = () =>
  signUnsubscribeTokenV2({
    tenantId: "ten_a",
    email: "alex@acme.test",
    recipientId: "pu_1",
    connectionId: "pcn_1",
    category: "onboarding",
    categoryLabel: "Onboarding tips",
  });

/** What an inbox provider sends for RFC 8058 one-click: form-encoded, token in the URL. */
const oneClick = (token: string) =>
  new Request(`${ORIGIN}/api/unsubscribe?u=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });

/** What the hosted page sends. */
const pagePost = (body: Record<string, unknown>) =>
  new Request(`${ORIGIN}/api/unsubscribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/unsubscribe", () => {
  beforeEach(() => {
    process.env.UNSUBSCRIBE_SIGNING_KEY = "test-key";
    applyUnsubscribe.mockClear();
    applyLifecycleUnsubscribe.mockClear();
  });
  afterEach(() => {
    delete process.env.UNSUBSCRIBE_SIGNING_KEY;
  });

  it("one-click on a lifecycle email stops only its category", async () => {
    const res = await POST(oneClick(v2()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, scope: "category" });
    expect(applyLifecycleUnsubscribe).toHaveBeenCalledWith(
      expect.objectContaining({ category: "onboarding", recipientId: "pu_1" }),
      "category",
      "list-unsubscribe",
    );
  });

  it("the page can choose 'everything'", async () => {
    const res = await POST(pagePost({ u: v2(), scope: "all" }));
    expect(await res.json()).toEqual({ ok: true, scope: "all" });
    expect(applyLifecycleUnsubscribe).toHaveBeenCalledWith(expect.anything(), "all", "preferences-page");
  });

  it("the page's category button stops the category", async () => {
    await POST(pagePost({ u: v2(), scope: "category" }));
    expect(applyLifecycleUnsubscribe).toHaveBeenCalledWith(expect.anything(), "category", "preferences-page");
  });

  it("a v1 (waitlist) token is still a tenant-wide unsubscribe", async () => {
    const token = signUnsubscribeToken({ tenantId: "ten_a", campaignId: "c1", signupId: "s1", email: "jo@acme.test" });
    const res = await POST(oneClick(token));
    expect(await res.json()).toEqual({ ok: true, scope: "all" });
    expect(applyUnsubscribe).toHaveBeenCalledWith(expect.objectContaining({ signupId: "s1" }), "footer");
    expect(applyLifecycleUnsubscribe).not.toHaveBeenCalled();
  });

  it("rejects a bad token", async () => {
    const res = await POST(oneClick("not-a-token"));
    expect(res.status).toBe(400);
    expect(applyLifecycleUnsubscribe).not.toHaveBeenCalled();
    expect(applyUnsubscribe).not.toHaveBeenCalled();
  });

  it("404s when the tenant is gone", async () => {
    applyLifecycleUnsubscribe.mockResolvedValueOnce({ ok: false, tenant: null });
    const res = await POST(oneClick(v2()));
    expect(res.status).toBe(404);
  });
});
