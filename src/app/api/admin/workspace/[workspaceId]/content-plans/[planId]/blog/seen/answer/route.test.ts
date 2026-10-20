import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// An answer to one of an article's questions, saved as it is typed: origin, switch, sign-in, the
// workspace and plan, a per-person limit, then the logic (tested in seenAnswers.test.ts).
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const content = vi.hoisted(() => ({ getContentPlan: vi.fn() }));
vi.mock("@/lib/tenant/workspaceContent", () => content);
const tenant = vi.hoisted(() => ({
  getById: vi.fn(),
  isRateLimited: vi.fn(async () => false),
}));
vi.mock("@/lib/tenant", () => ({ forTenant: () => ({ workspaces: { getById: tenant.getById } }), isRateLimited: tenant.isRateLimited }));
const logic = vi.hoisted(() => ({ answerForArticle: vi.fn() }));
vi.mock("@/lib/content/blog/seenAnswers", () => logic);

const { PUT } = await import("./route");

const member = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_member", role: "member" };
const params = { params: Promise.resolve({ workspaceId: "ws_1", planId: "plan_1" }) };
const BODY = { noteId: "bn_abcdef123456", text: "We ran the same question every day for a week." };
const req = (body: unknown = BODY, extra: Record<string, string> = {}) =>
  new Request("http://localhost/api/admin/workspace/ws_1/content-plans/plan_1/blog/seen/answer", {
    method: "PUT",
    headers: { "content-type": "application/json", host: "localhost", ...extra },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  for (const v of ["BRAND_NOTES_ENABLED", "BRAND_NOTES_QUESTIONS_ENABLED", "CREATE_BLOG_EDITORIAL_ENABLED", "CREATE_BLOG_CITABLE_ENABLED"]) vi.stubEnv(v, "true");
  session.getAdminContext.mockResolvedValue(member);
  tenant.getById.mockResolvedValue({ id: "ws_1" });
  content.getContentPlan.mockResolvedValue({ id: "plan_1", blog: { subjectId: "sub_1" } });
  logic.answerForArticle.mockResolvedValue({ status: 200, body: { question: { id: BODY.noteId, answer: BODY.text, status: "kept" } } });
});
afterEach(() => vi.unstubAllEnvs());

describe("saving an answer to an article's question", () => {
  it("503 with the switch off, before sign-in", async () => {
    vi.stubEnv("BRAND_NOTES_QUESTIONS_ENABLED", "false");
    expect((await PUT(req(), params)).status).toBe(503);
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("refuses another site, nobody signed out, and a workspace or plan that isn't there", async () => {
    expect((await PUT(req(BODY, { origin: "https://evil.example" }), params)).status).toBe(403);
    session.getAdminContext.mockResolvedValueOnce(null);
    expect((await PUT(req(), params)).status).toBe(401);
    tenant.getById.mockResolvedValueOnce(null);
    expect((await PUT(req(), params)).status).toBe(404);
    content.getContentPlan.mockResolvedValueOnce(null);
    expect((await PUT(req(), params)).status).toBe(404);
    expect(logic.answerForArticle).not.toHaveBeenCalled();
  });

  it("429 past the per-person limit", async () => {
    tenant.isRateLimited.mockResolvedValueOnce(true);
    expect((await PUT(req(), params)).status).toBe(429);
    expect(tenant.isRateLimited).toHaveBeenCalledWith("user:ten_A:usr_member", expect.objectContaining({ prefix: "blog_seen_answer" }));
  });

  it("lets a member answer, for this article and its subject, and passes on what the logic says", async () => {
    const ok = await PUT(req(), params);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ question: { status: "kept" } });
    expect(logic.answerForArticle).toHaveBeenCalledWith(member, { article: "ws_1/plan_1", subjectId: "sub_1", body: BODY });
    logic.answerForArticle.mockResolvedValueOnce({ status: 403, body: { error: "not_asked_here" } });
    expect((await PUT(req(), params)).status).toBe(403);
  });
});
