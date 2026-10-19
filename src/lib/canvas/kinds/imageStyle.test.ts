import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import type { TenantContext } from "@/lib/tenant/types";
import { authorImageStyleSuggestion } from "./imageStyle";
import { agentImageStyle } from "@/lib/content/imageStyle/agentApi";

const admin: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "usr_admin", role: "admin" };
const member: TenantContext = { ...admin, userId: "usr_member", role: "member" };
const SAVED = { defaultStyleId: "headline_card", channels: { linkedin: "natural_photo" }, updatedAt: "2026-10-01T00:00:00.000Z" };

function world(over: Record<string, unknown> = {}) {
  const db = new FakeFirestore();
  db.seed("tenants", "ten_A", {
    id: "ten_A",
    tenantName: "Example Co",
    rootDomain: "example.com",
    status: "active",
    region: "us",
    allowedOrigins: ["https://example.com"],
    billingTier: "mvp_free",
    ownerId: "usr_owner",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    imageStyle: SAVED,
    ...over,
  });
  return db;
}
const suggest = (db: FakeFirestore, input: unknown, ctx = admin) => authorImageStyleSuggestion({ ctx, input, brief: "" } as never, { db });

beforeEach(() => {
  __resetRateLimitState();
  vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("image_style canvas kind", () => {
  it("writes only the suggestion; the style images use is untouched", async () => {
    const db = world();
    const r = await suggest(db, { defaultStyleId: "product_noir", channels: { instagram: "soft_3d" }, reason: "Your site shows dark product screens." });
    expect(r).toMatchObject({ ok: true, status: "suggested", url: "/admin/brand-kit/image-style" });
    if (!r.ok) throw new Error("expected ok");
    expect(r.summary).toBe(
      "Suggested Product noir as the brand's image style, with Soft 3D for instagram. It's only a suggestion: nothing changes until an admin reviews and saves it in Brand › Image style.",
    );
    const stored = db.raw("tenants", "ten_A") as Record<string, unknown>;
    expect(stored.imageStyleSuggestion).toMatchObject({ defaultStyleId: "product_noir", channels: { instagram: "soft_3d" }, suggestedBy: "usr_admin" });
    expect(stored.imageStyle).toEqual(SAVED);
  });

  it("only admins, only with the switch on, only styles that are built", async () => {
    const db = world();
    expect(await suggest(db, { defaultStyleId: "soft_3d", reason: "x" }, member)).toMatchObject({ ok: false, status: 403 });
    expect(await suggest(db, { defaultStyleId: "type_poster", reason: "Bold numbers." })).toMatchObject({ ok: false, error: "style_not_built" });
    expect(await suggest(db, { defaultStyleId: "nope", reason: "x" })).toMatchObject({ ok: false, error: "invalid_input" });
    expect(await suggest(db, { defaultStyleId: "soft_3d", reason: "" })).toMatchObject({ ok: false, error: "invalid_input" });
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "false");
    expect(await suggest(db, { defaultStyleId: "soft_3d", reason: "x" })).toMatchObject({ ok: false, status: 503 });
  });

  it("Vizzy's read: what's saved, what's pending, and what can be picked", async () => {
    const db = world({ imageStyleSuggestion: { defaultStyleId: "soft_3d", reason: "Playful.", suggestedBy: "usr_admin", suggestedAt: "2026-10-02T00:00:00.000Z" } });
    const r = await agentImageStyle(admin, db as never);
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown> & { styles: { id: string; built: boolean }[] };
    expect(body.current).toMatchObject({ defaultStyleId: "headline_card", defaultLabel: "Headline card", channels: { linkedin: "natural_photo" } });
    expect(body.pending).toMatchObject({ defaultLabel: "Soft 3D", reason: "Playful." });
    expect(body.pending).not.toHaveProperty("suggestedBy");
    expect(body.styles.find((s) => s.id === "type_poster")?.built).toBe(false);
    expect(body).toMatchObject({ canSuggest: true });
    expect(((await agentImageStyle(member, db as never)).body as { canSuggest: boolean }).canSuggest).toBe(false);
  });
});
