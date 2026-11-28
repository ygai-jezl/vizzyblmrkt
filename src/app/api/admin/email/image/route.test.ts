import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoopStamp } from "@/lib/types/loopStamp";

// The launch email hero: off, the hero model and today's prompt (no direction); on, the brand's launch
// email style, else the hero's own pick.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenantMod = vi.hoisted(() => ({
  forTenant: vi.fn(() => ({ campaigns: { getById: vi.fn(async () => ({ id: "camp_1" })) } })),
  getTenantById: vi.fn(),
}));
vi.mock("@/lib/tenant", () => tenantMod);
const agents = vi.hoisted(() => ({
  generateHeroImage: vi.fn(async (_input: Record<string, unknown>) => ({ imageUrl: "https://x/i.png", source: "agent3" })),
}));
vi.mock("@/lib/agents", () => agents);
vi.mock("@/lib/content/create/activeBrandVoice", () => ({ activeBrandVoiceText: vi.fn(async () => null) }));
// The learning loops (step 4): the reader, the count and the token, watched.
vi.mock("@/lib/loops/read", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/loops/read")>();
  return { ...real, learnedFor: vi.fn(real.learnedFor) };
});
vi.mock("@/lib/loops/count", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/loops/count")>()),
  countMade: vi.fn(async () => undefined),
}));
vi.mock("@/lib/loops/stamp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/loops/stamp")>()),
  signStamp: vi.fn(async () => "st1.token.sig"),
}));
const loopsRead = await import("@/lib/loops/read");
const loopsCount = await import("@/lib/loops/count");
const loopsStamp = await import("@/lib/loops/stamp");

const { POST } = await import("./route");
const req = (body: unknown) =>
  new Request("http://localhost/api/admin/email/image", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const last = () => agents.generateHeroImage.mock.calls.at(-1)![0];

beforeEach(() => {
  vi.clearAllMocks();
  session.getAdminContext.mockResolvedValue({ tenantId: "ten_A", region: "us", userId: "u", role: "admin" });
  tenantMod.getTenantById.mockResolvedValue({ imageStyle: { defaultStyleId: "headline_card", channels: { launchEmail: "natural_photo" } } });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/admin/email/image", () => {
  it("off: no direction, no tenant read, the response as before", async () => {
    const res = await POST(req({ campaignId: "camp_1", brief: "Launch day", styleId: "soft_3d" }));
    expect(last()).toMatchObject({ direction: null });
    expect(tenantMod.getTenantById).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ imageUrl: "https://x/i.png", source: "agent3" });
  });

  it("on: the brand's launch email style, or the hero's own pick", async () => {
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    await POST(req({ campaignId: "camp_1", brief: "Launch day" }));
    expect(last()).toMatchObject({ direction: { label: "Natural photo" } });
    const res = await POST(req({ campaignId: "camp_1", brief: "Launch day", styleId: "paper_collage" }));
    expect(last()).toMatchObject({ direction: { label: "Paper collage" } });
    expect(await res.json()).toMatchObject({ imageStyleId: "paper_collage", styleId: "paper_collage" });
  });

  it("answers 429 with the message at the brand's image cap", async () => {
    const { IMAGE_LIMIT_MESSAGE } = await import("@/lib/plans/resources");
    agents.generateHeroImage.mockResolvedValueOnce({ imageUrl: null, source: "unavailable", reason: "image_limit" } as never);
    const res = await POST(req({ campaignId: "camp_1", brief: "Launch day" }));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "image_limit", reason: "image_limit", message: IMAGE_LIMIT_MESSAGE });
    expect(last()).toHaveProperty("usage");
  });
});

describe("POST /api/admin/email/image with image style versions on (learning loops step 4)", () => {
  const stamp: LoopStamp = {
    made: "m1.image_style.natural_photo.1.l",
    kind: "email_hero",
    scope: "image_style.natural_photo",
    v: 1,
    arm: "learned",
    items: ["look1"],
    prompt: null,
    tokens: { rules: 6, examples: 0 },
    at: "2027-01-15T10:00:00.000Z",
  };
  beforeEach(() => {
    vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
    vi.mocked(loopsRead.learnedFor).mockResolvedValue({ block: { look: "Warm daylight on flour.", holdback: false }, stamp });
  });

  it("reads the look for the hero's style and counts the image once stored, with no token, since the email's save checks none", async () => {
    const res = await POST(req({ campaignId: "camp_1", brief: "Opening day" }));
    expect(vi.mocked(loopsRead.learnedFor).mock.calls.at(-1)!.slice(1, 3)).toEqual([
      "email_hero",
      { scope: "image_style.natural_photo", outputId: expect.any(String), promptId: "creative.image_brief" },
    ]);
    expect(last()).toMatchObject({ learnedImageStyle: "Warm daylight on flour." });
    expect(loopsCount.countMade).toHaveBeenCalledWith(expect.anything(), "email_hero", stamp, {});
    // No save of the email checks a token yet, so none is signed (and the brand's key isn't read).
    expect(loopsStamp.signStamp).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body).toMatchObject({ imageUrl: "https://x/i.png" });
    expect(body).not.toHaveProperty("stampToken");
  });

  it("counts nothing and hands back no token when no image was made", async () => {
    agents.generateHeroImage.mockResolvedValueOnce({ imageUrl: null, source: "unavailable", reason: "image_model_unavailable" } as never);
    const res = await POST(req({ campaignId: "camp_1", brief: "Opening day" }));
    expect(loopsCount.countMade).not.toHaveBeenCalled();
    expect(await res.json()).not.toHaveProperty("stampToken");
  });

  it("held back: no look in the brief, and the stamp it counts says so", async () => {
    const held: LoopStamp = { ...stamp, made: "m1.image_style.natural_photo.1.h", arm: "holdback", items: [], tokens: { rules: 0, examples: 0 } };
    vi.mocked(loopsRead.learnedFor).mockResolvedValueOnce({ block: { look: null, holdback: true }, stamp: held });
    await POST(req({ campaignId: "camp_1", brief: "Opening day" }));
    expect(last()).toMatchObject({ learnedImageStyle: null });
    expect(loopsCount.countMade).toHaveBeenCalledWith(expect.anything(), "email_hero", held, {});
  });
});
