import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { signCanvasContext } from "@/lib/canvas/auth";
import { agentReadNotes, agentSuggestNotes, brandNotesAgentGate } from "./agentApi";
import { askQuestions, createNote, listNotes } from "./store";

const member: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "usr_m", role: "member" };
const req = (token?: string) => new Request("https://app.example.com/api/agent/brand-notes", { headers: token ? { "x-canvas-context": token } : {} });
const deps = (db = new FakeFirestore()) => ({ db, embed: vi.fn(async (items: unknown[]) => items.map(() => [0.1])), limited: async () => false });

beforeEach(() => {
  vi.stubEnv("BRAND_NOTES_ENABLED", "true");
  vi.stubEnv("BRAND_NOTES_CHAT_ENABLED", "true");
  vi.stubEnv("CANVAS_CONTEXT_SIGNING_KEY", "test-only-canvas-key");
});
afterEach(() => vi.unstubAllEnvs());

describe("Vizzy and What we've seen", () => {
  it("is gated by its switch and the signed token", () => {
    expect(brandNotesAgentGate(req())).toMatchObject({ ok: false, result: { status: 401 } });
    expect(brandNotesAgentGate(req(signCanvasContext(member)))).toMatchObject({ ok: true, ctx: { tenantId: "ten_A" } });
    vi.stubEnv("BRAND_NOTES_CHAT_ENABLED", "false");
    expect(brandNotesAgentGate(req(signCanvasContext(member)))).toMatchObject({ ok: false, result: { status: 503 } });
  });

  it("files notes only as suggestions, in the words given, and says an admin keeps them", async () => {
    const d = deps();
    const r = await agentSuggestNotes(member, { notes: [{ text: "We ran the same question daily for a week and the brands changed." }, { text: "Buyers ask why they can't just check by hand.", kind: "objection" }] }, d);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ filed: 2, link: "/admin/brand-kit/notes" });
    expect((r.body as { message: string }).message).toContain("An admin keeps");
    const notes = await listNotes(member, d);
    expect(notes.map((n) => [n.status, n.source, n.kind]).sort()).toEqual([
      ["suggested", "chat", "objection"],
      ["suggested", "chat", "tested"],
    ]);
  });

  it("refuses an empty or oversized call, and a busy one", async () => {
    expect((await agentSuggestNotes(member, { notes: [] }, deps())).status).toBe(400);
    expect((await agentSuggestNotes(member, { notes: Array.from({ length: 6 }, () => ({ text: "Something we saw twice this year." })) }, deps())).status).toBe(400);
    expect((await agentSuggestNotes(member, { notes: [{ text: "Something we saw twice this year." }] }, { ...deps(), limited: async () => true })).status).toBe(429);
  });

  it("reads the kinds the brand has fewest of, and the newest kept notes", async () => {
    const d = deps();
    await createNote(member, { text: "We tested daily checks for a month.", kind: "tested", subjectIds: [], canName: false }, { source: "typed" }, d);
    await createNote(member, { text: "Waiting for an admin to keep it.", kind: "mistake", subjectIds: [], canName: false }, { source: "chat", status: "suggested" }, d);
    const r = await agentReadNotes(member, {}, d);
    expect(r.body).toMatchObject({ total: 2, kept: 1, waiting: 1, notes: [{ kind: "tested" }] });
    expect((r.body as { fewest: string[] }).fewest).toContain("disagree");
    expect((r.body as { fewest: string[] }).fewest).not.toContain("tested");
  });

  it("reads the open questions apart, with the articles that asked them, once they are on", async () => {
    const d = deps();
    await createNote(member, { text: "We tested daily checks for a month.", kind: "tested", subjectIds: [], canName: false }, { source: "typed" }, d);
    await askQuestions(member, { questions: ["When did a weekly check miss a change?"], article: { ref: "ws_1/plan_1", title: "How often to check" } }, d);
    const off = await agentReadNotes(member, {}, d);
    expect(off.body).toMatchObject({ total: 1, kept: 1, waiting: 0 });
    expect((off.body as { open?: unknown }).open).toBeUndefined();
    vi.stubEnv("BRAND_NOTES_QUESTIONS_ENABLED", "true");
    const on = await agentReadNotes(member, {}, d);
    expect(on.body).toMatchObject({
      total: 1,
      waiting: 0,
      open: { count: 1, questions: [{ question: "When did a weekly check miss a change?", askedFor: ["How often to check"] }] },
    });
  });
});
