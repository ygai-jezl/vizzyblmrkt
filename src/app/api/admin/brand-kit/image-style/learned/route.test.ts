import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What image style learned, changed by a person: image style versions on, sign in, admin, then a
// strict body; the member comes from the session.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const review = vi.hoisted(() => ({ forgetReviewCount: vi.fn() }));
vi.mock("@/lib/review/summary", () => review);
const actions = vi.hoisted(() => ({
  undoLook: vi.fn(async () => ({ ok: true, v: 3, restored: 1 })),
  setImageLearningPaused: vi.fn(async () => ({ ok: true })),
  resumeSuggestions: vi.fn(async () => ({ ok: true })),
  forgetLook: vi.fn(async () => ({ ok: true, v: 3, scopes: ["image_style.natural_photo"] })),
  forgetPreview: vi.fn(async () => ({ ok: true, liked: 3, disliked: 2, brandOverlap: 0 })),
  editLook: vi.fn(async () => ({ ok: true, v: 3 })),
  keepLook: vi.fn(async () => ({ ok: true, v: 2 })),
  goBackLook: vi.fn(async () => ({ ok: true, v: 3, restored: 1 })),
  forgetUndone: vi.fn(async () => ({ ok: true, v: 3, scopes: ["image_style.natural_photo"] })),
  setHelpCheck: vi.fn(async () => ({ ok: true, offSince: "2027-06-03T09:00:00.000Z" })),
}));
vi.mock("@/lib/loops/actions", () => actions);
const views = vi.hoisted(() => ({
  learnedCardView: vi.fn(async () => ({ role: "member", rows: [] })),
  imageVoteView: vi.fn(async () => ({ image: null, notice: null, standing: null, startClosed: false })),
}));
vi.mock("@/lib/loops/learnedView", () => views);

const { GET, POST } = await import("./route");

const admin = { tenantId: "ten_hearth", region: "us", source: "idtoken", userId: "usr_maya", role: "admin" };
const member = { ...admin, userId: "usr_sam", role: "member" };
const NATURAL = "image_style.natural_photo";
const post = (body: unknown) =>
  POST(new Request("http://localhost/api/admin/brand-kit/image-style/learned", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
  vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
  vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/admin/brand-kit/image-style/learned", () => {
  it("503s with the image style or its versions off, before anything changes", async () => {
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "");
    expect((await post({ op: "undo", scope: NATURAL })).status).toBe(503);
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "");
    expect((await post({ op: "undo", scope: NATURAL })).status).toBe(503);
    expect(session.getAdminContext).not.toHaveBeenCalled();
    expect(actions.undoLook).not.toHaveBeenCalled();
  });

  it("401s signed out and 403s a member", async () => {
    session.getAdminContext.mockResolvedValueOnce(null);
    expect((await post({ op: "pause" })).status).toBe(401);
    session.getAdminContext.mockResolvedValueOnce(member);
    expect((await post({ op: "pause" })).status).toBe(403);
    expect(actions.setImageLearningPaused).not.toHaveBeenCalled();
  });

  it("400s an unknown op, a scope that doesn't learn, a stray field or a tenant in the body", async () => {
    for (const body of [{ op: "delete", scope: NATURAL }, { op: "undo", scope: "image_style.headline_card" }, { op: "pause", scope: NATURAL }, { op: "undo", scope: NATURAL, tenantId: "ten_other" }, null]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(actions.undoLook).not.toHaveBeenCalled();
  });

  it("runs each op with the session's brand and member, and forgets Review's cached count", async () => {
    expect(await (await post({ op: "undo", scope: NATURAL })).json()).toEqual({ ok: true, v: 3, restored: 1 });
    expect(actions.undoLook).toHaveBeenCalledWith(admin, NATURAL);
    await post({ op: "pause" });
    expect(actions.setImageLearningPaused).toHaveBeenCalledWith(admin, true);
    await post({ op: "resume" });
    expect(actions.setImageLearningPaused).toHaveBeenLastCalledWith(admin, false);
    await post({ op: "resume_suggestions" });
    expect(actions.resumeSuggestions).toHaveBeenCalledWith(admin);
    await post({ op: "forget", scope: NATURAL, alsoBrand: true });
    expect(actions.forgetLook).toHaveBeenCalledWith(admin, NATURAL, { alsoBrand: true });
    expect(await (await post({ op: "forget_preview", scope: NATURAL })).json()).toEqual({ ok: true, liked: 3, disliked: 2, brandOverlap: 0 });
    await post({ op: "edit", scope: NATURAL, text: "Overhead daylight, flour on dark wood." });
    expect(actions.editLook).toHaveBeenCalledWith(admin, NATURAL, "Overhead daylight, flour on dark wood.");
    await post({ op: "keep", target: { cardId: "aa_0123456789abcdef0123456789abcdef01234567" } });
    expect(actions.keepLook).toHaveBeenCalledWith(admin, { cardId: "aa_0123456789abcdef0123456789abcdef01234567" });
    await post({ op: "go_back", target: { scope: NATURAL } });
    expect(actions.goBackLook).toHaveBeenCalledWith(admin, { scope: NATURAL });
    expect(review.forgetReviewCount).toHaveBeenCalledWith("ten_hearth");
  });

  it("says why a change was refused, with the words a person sees", async () => {
    actions.editLook.mockResolvedValueOnce({ ok: false, error: "text_refused", message: "This look can't be saved: it has a link, email address, handle or phone number. Take it out and save again." } as never);
    const refused = await post({ op: "edit", scope: NATURAL, text: "See https://hearth.example.com" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "text_refused", message: "This look can't be saved: it has a link, email address, handle or phone number. Take it out and save again." });
    actions.goBackLook.mockResolvedValueOnce({ ok: false, error: "moved" } as never);
    expect((await post({ op: "go_back", target: { scope: NATURAL } })).status).toBe(409);
    actions.undoLook.mockResolvedValueOnce({ ok: false, error: "forgotten" } as never);
    const forgotten = await post({ op: "undo", scope: NATURAL });
    expect(forgotten.status).toBe(409);
    expect(await forgotten.json()).toEqual({ error: "forgotten", message: "This look was forgotten, so there is nothing to undo." });
    // An Undo back to a look a Forget emptied can never work: it says so instead of "Try again".
    actions.undoLook.mockResolvedValueOnce({ ok: false, error: "words_removed" } as never);
    const removed = await post({ op: "undo", scope: NATURAL });
    expect(removed.status).toBe(409);
    expect(await removed.json()).toEqual({ error: "words_removed", message: "The look before this one was forgotten, so there is nothing to go back to." });
  });
});

describe("POST, the Undo done line's Forget and the learning setting", () => {
  it("forgets the look an Undo just left, and turns Help check that learning works off or on", async () => {
    expect(await (await post({ op: "forget_undone", scope: NATURAL })).json()).toEqual({ ok: true, v: 3, scopes: [NATURAL] });
    expect(actions.forgetUndone).toHaveBeenCalledWith(admin, NATURAL);
    expect(await (await post({ op: "help_check", on: false })).json()).toEqual({ ok: true, offSince: "2027-06-03T09:00:00.000Z" });
    expect(actions.setHelpCheck).toHaveBeenCalledWith(admin, false);
    expect((await post({ op: "help_check", on: "no" })).status).toBe(400);
    session.getAdminContext.mockResolvedValueOnce(member);
    expect((await post({ op: "help_check", on: true })).status).toBe(403);
  });

  it("with only LOOPS_ENABLED on, answers the learning setting alone, signed in and admin, so a brand can leave the counts", async () => {
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "");
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "");
    vi.stubEnv("LOOPS_ENABLED", "true");
    expect(await (await post({ op: "help_check", on: false })).json()).toEqual({ ok: true, offSince: "2027-06-03T09:00:00.000Z" });
    expect(actions.setHelpCheck).toHaveBeenCalledWith(admin, false);
    // Every other change needs image style versions.
    expect((await post({ op: "undo", scope: NATURAL })).status).toBe(503);
    expect(actions.undoLook).not.toHaveBeenCalled();
    session.getAdminContext.mockResolvedValueOnce(member);
    expect((await post({ op: "help_check", on: true })).status).toBe(403);
    session.getAdminContext.mockResolvedValueOnce(null);
    expect((await post({ op: "help_check", on: true })).status).toBe(401);
  });
});

describe("GET /api/admin/brand-kit/image-style/learned", () => {
  const get = (q = "") => GET(new Request(`http://localhost/api/admin/brand-kit/image-style/learned${q}`));

  it("503s with versions off, and 401s signed out, before reading anything", async () => {
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "");
    expect((await get()).status).toBe(503);
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
    session.getAdminContext.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(401);
    expect(views.learnedCardView).not.toHaveBeenCalled();
  });

  it("gives any member the card, for the session's brand", async () => {
    session.getAdminContext.mockResolvedValueOnce(member);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(views.learnedCardView).toHaveBeenCalledWith(member);
  });

  it("gives one image's vote view by filename or id, and refuses a bad one", async () => {
    await get("?image=n1.png&style=natural_photo");
    expect(views.imageVoteView).toHaveBeenLastCalledWith(admin, { file: "n1.png", style: "natural_photo" });
    await get("?asset=img_1");
    expect(views.imageVoteView).toHaveBeenLastCalledWith(admin, { assetId: "img_1", style: null });
    await get("?style=natural_photo");
    expect(views.imageVoteView).toHaveBeenLastCalledWith(admin, { style: "natural_photo" });
    expect((await get("?image=../../etc")).status).toBe(400);
    expect((await get("?style=Natural%20photo")).status).toBe(400);
  });
});
