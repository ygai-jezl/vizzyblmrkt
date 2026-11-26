import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A vote teaches the brand's one look as before, and (image style on) the image's own style.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const kit = vi.hoisted(() => ({ setImageBrandVote: vi.fn(), setImageVoteReason: vi.fn() }));
vi.mock("@/lib/admin/brandKit", () => kit);
const profile = vi.hoisted(() => ({
  refreshExemplarStyle: vi.fn(async () => undefined),
  refreshLearnedImageStyle: vi.fn(async () => undefined),
  refreshLearnedStyleBucket: vi.fn(async () => undefined),
}));
vi.mock("@/lib/content/create/styleProfile", () => profile);
const learner = vi.hoisted(() => ({ profileImage: vi.fn(async () => "profiled") }));
vi.mock("@/lib/loops/learners/votes", () => learner);
const control = vi.hoisted(() => ({ setTenantLearnedImageStyle: vi.fn(), setTenantStyleLearned: vi.fn() }));
vi.mock("@/lib/tenant/control", () => control);

const { POST } = await import("./route");
const params = { params: Promise.resolve({ assetId: "img_1" }) };
const req = (body: unknown) =>
  new Request("http://localhost/api/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_KIT_ENABLED", "true");
  session.getAdminContext.mockResolvedValue({ tenantId: "ten_A", region: "us", userId: "u", role: "admin" });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST image feedback", () => {
  it("off: only the brand's one look learns", async () => {
    kit.setImageBrandVote.mockResolvedValue({ id: "img_1", style: "soft_3d" });
    await POST(req({ vote: "up", rating: 9 }), params);
    expect(profile.refreshExemplarStyle).toHaveBeenCalled();
    expect(profile.refreshLearnedStyleBucket).not.toHaveBeenCalled();
  });

  it("on: the image's style learns too (old presets by the style they map to; templates never)", async () => {
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    kit.setImageBrandVote.mockResolvedValue({ id: "img_1", style: "earthy" });
    await POST(req({ vote: "down" }), params);
    expect(profile.refreshLearnedImageStyle).toHaveBeenCalled();
    expect(profile.refreshLearnedStyleBucket).toHaveBeenCalledWith(expect.anything(), "natural_photo");

    vi.clearAllMocks();
    kit.setImageBrandVote.mockResolvedValue({ id: "img_2", style: "headline_card" });
    await POST(req({ vote: "up", rating: 8 }), params);
    expect(profile.refreshLearnedStyleBucket).not.toHaveBeenCalled();
  });
});

describe("POST image feedback: the why behind a vote (learning loops step 4, 3.11)", () => {
  function versionsOn() {
    vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
  }

  it("with versions off is refused as before, and nothing is kept", async () => {
    const res = await POST(req({ reason: "mood", note: "too dark" }), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_input" });
    expect(kit.setImageVoteReason).not.toHaveBeenCalled();
  });

  it("keeps a reason and note after the vote, for any member, with no style learning run", async () => {
    versionsOn();
    session.getAdminContext.mockResolvedValue({ tenantId: "ten_A", region: "us", userId: "u", role: "member" });
    kit.setImageVoteReason.mockResolvedValue({ ok: true, image: { id: "img_1", brandVote: "down", brandVoteReason: "mood" } });
    const res = await POST(req({ reason: "mood", note: "too dark for a bakery window" }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ image: { id: "img_1", brandVote: "down", brandVoteReason: "mood" } });
    expect(kit.setImageVoteReason).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "ten_A" }), "img_1", { reason: "mood", note: "too dark for a bakery window" });
    expect(kit.setImageBrandVote).not.toHaveBeenCalled();
    expect(profile.refreshExemplarStyle).not.toHaveBeenCalled();
    expect(profile.refreshLearnedImageStyle).not.toHaveBeenCalled();
  });

  it("says why a reason or note wasn't kept, and keeps the box open on a refused note", async () => {
    versionsOn();
    kit.setImageVoteReason.mockResolvedValueOnce({ ok: false, error: "note_refused" });
    const refused = await POST(req({ reason: "mood", note: "see hearthbakery.com" }), params);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "note_refused", message: "Leave out links, email addresses, handles and phone numbers." });

    kit.setImageVoteReason.mockResolvedValueOnce({ ok: false, error: "no_vote" });
    expect((await POST(req({ reason: "mood" }), params)).status).toBe(409);
    kit.setImageVoteReason.mockResolvedValueOnce({ ok: false, error: "not_found" });
    expect((await POST(req({ reason: null }), params)).status).toBe(404);

    // A note longer than 200 characters, or a field the route doesn't know, is refused before anything is read.
    expect((await POST(req({ reason: "mood", note: "x".repeat(201) }), params)).status).toBe(400);
    expect((await POST(req({ reason: "mood", tenantId: "ten_B" }), params)).status).toBe(400);
    expect(kit.setImageVoteReason).toHaveBeenCalledTimes(3);
  });

  it("still takes a vote with versions on", async () => {
    versionsOn();
    kit.setImageBrandVote.mockResolvedValue({ id: "img_1", style: "natural_photo" });
    const res = await POST(req({ vote: "down" }), params);
    expect(res.status).toBe(200);
    expect(kit.setImageBrandVote).toHaveBeenCalledWith(expect.anything(), "img_1", { vote: "down", rating: null });
    expect(kit.setImageVoteReason).not.toHaveBeenCalled();
  });
});

describe("POST image feedback with versions on (learning loops step 4, decision 7)", () => {
  beforeEach(() => {
    vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
    kit.setImageBrandVote.mockResolvedValue({ id: "img_1", style: "natural_photo", brandVote: "up" });
  });

  it("profiles the image on an up or a down vote, and rewrites no look", async () => {
    for (const body of [{ vote: "up", rating: 8 }, { vote: "down" }]) {
      const res = await POST(req(body), params);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ image: { id: "img_1", style: "natural_photo", brandVote: "up" } });
    }
    expect(learner.profileImage).toHaveBeenCalledTimes(2);
    expect(learner.profileImage).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "ten_A" }), "img_1");
    for (const fn of Object.values(profile)) expect(fn).not.toHaveBeenCalled();
    expect(control.setTenantLearnedImageStyle).not.toHaveBeenCalled();
    expect(control.setTenantStyleLearned).not.toHaveBeenCalled();
  });

  it("profiles nothing when a vote is cleared, and a profile that fails never fails the vote", async () => {
    await POST(req({ vote: null }), params);
    expect(learner.profileImage).not.toHaveBeenCalled();
    learner.profileImage.mockRejectedValueOnce(new Error("model down"));
    expect((await POST(req({ vote: "up" }), params)).status).toBe(200);
  });

  it("leaves pausing to profileImage, which profiles nothing while image learning is paused", async () => {
    learner.profileImage.mockResolvedValueOnce("paused");
    expect((await POST(req({ vote: "down" }), params)).status).toBe(200);
    expect(profile.refreshLearnedImageStyle).not.toHaveBeenCalled();
  });
});
