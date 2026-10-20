import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Brand › What we've seen: flag, then sign-in, then (to change anything) admin; the store does the rest.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({
  listNotes: vi.fn(async () => []),
  summariseNotes: vi.fn(() => ({ total: 0 })),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  removeNote: vi.fn(),
  answerQuestion: vi.fn(),
}));
vi.mock("@/lib/brandNotes/store", () => store);
const limits = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant", () => limits);

const { GET, POST } = await import("./route");
const { PATCH, DELETE } = await import("./[noteId]/route");
const { PUT: ANSWER } = await import("./[noteId]/answer/route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const member = { ...admin, userId: "usr_member", role: "member" };
const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api/admin/brand-kit/notes", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const params = { params: Promise.resolve({ noteId: "bn_abcdef123456" }) };
const NOTE = { text: "Teams that checked daily stopped reading within a month.", kind: "mistake" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_NOTES_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
  store.createNote.mockResolvedValue({ ok: true, value: { id: "bn_new", ...NOTE } });
  store.updateNote.mockResolvedValue({ ok: false, status: 404, error: "not_found" });
  store.removeNote.mockResolvedValue({ ok: true, value: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("the What we've seen APIs", () => {
  it("503 with the switch off, before sign-in", async () => {
    vi.stubEnv("BRAND_NOTES_ENABLED", "");
    expect((await GET(req("GET"))).status).toBe(503);
    expect((await POST(req("POST", NOTE))).status).toBe(503);
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("let a member read but not change, and nobody signed out", async () => {
    session.getAdminContext.mockResolvedValue(member);
    expect((await GET(req("GET"))).status).toBe(200);
    expect((await POST(req("POST", NOTE))).status).toBe(403);
    expect((await PATCH(req("PATCH", { kind: "tested" }), params)).status).toBe(403);
    expect((await DELETE(req("DELETE"), params)).status).toBe(403);
    session.getAdminContext.mockResolvedValue(null);
    expect((await GET(req("GET"))).status).toBe(401);
    expect(store.createNote).not.toHaveBeenCalled();
  });

  it("add a note an admin typed, and say what is wrong with one that can't be saved", async () => {
    const ok = await POST(req("POST", NOTE));
    expect(ok.status).toBe(201);
    expect(store.createNote).toHaveBeenCalledWith(admin, expect.objectContaining({ text: NOTE.text, kind: "mistake", canName: false }), { source: "typed" }, {});
    const bad = await POST(req("POST", { text: "too short", kind: "nope" }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { issues: string[] }).issues.length).toBeGreaterThan(0);
  });

  it("pass the store's answer on for a change or a removal", async () => {
    expect((await PATCH(req("PATCH", { kind: "tested" }), params)).status).toBe(404);
    expect((await DELETE(req("DELETE"), params)).status).toBe(200);
  });

  it("answer an open question as it is typed, for admins, with open questions on", async () => {
    store.answerQuestion.mockResolvedValue({ ok: true, value: { id: "bn_abcdef123456", status: "kept" } });
    expect((await ANSWER(req("PUT", { text: "We ran the same question daily." }), params)).status).toBe(503);
    vi.stubEnv("BRAND_NOTES_QUESTIONS_ENABLED", "true");
    const ok = await ANSWER(req("PUT", { text: "We ran the same question daily.", done: true }), params);
    expect(ok.status).toBe(200);
    expect(store.answerQuestion).toHaveBeenCalledWith(admin, "bn_abcdef123456", "We ran the same question daily.", { done: true }, {});
    expect((await ANSWER(req("PUT", { text: 3 }), params)).status).toBe(400);
    limits.isRateLimited.mockResolvedValueOnce(true);
    expect((await ANSWER(req("PUT", { text: "We ran it." }), params)).status).toBe(429);
    session.getAdminContext.mockResolvedValue(member);
    expect((await ANSWER(req("PUT", { text: "We ran it." }), params)).status).toBe(403);
    expect(store.answerQuestion).toHaveBeenCalledTimes(1);
  });
});
