import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { signCanvasContext } from "@/lib/canvas/auth";
import { agentRaiseDocs, raiseAgentGate } from "./agentApi";
import { createRaiseDoc } from "./store";
import { typedBlock } from "./metrics";
import { ACME, ACME_MEMBER, FERNHILL, NOW, block, preSeedSlides, weeksOf } from "./testing/fixtures";
import type { RaiseDoc, Slide } from "./types";

let db: FakeFirestore;
const metrics = { weekly: async () => weeksOf(Array(12).fill(10)), launches: async () => null };
const deps = () => ({ db, now: () => NOW, metrics });

async function make(ctx = ACME, title = "Acme pre-seed", over: (s: Slide[]) => Slide[] = (s) => s, at: Date = NOW): Promise<RaiseDoc> {
  const slides = preSeedSlides();
  slides[3] = { ...slides[3]!, layout: "chart", headline: "{{mb_aaaaaaaa}} sign-ups in {{mb_aaaaaaaa:period}}", blocks: [block()] };
  const r = await createRaiseDoc(ctx, { audience: "investor", stage: "pre_seed", title, slides: over(slides), sources: [], outline: "investor_pre_seed", by: "vizzy", note: "First draft by Vizzy." }, { db, now: () => at });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const req = (token: string) => new Request("http://localhost/api/agent/raise/docs", { headers: { "x-canvas-context": token } });

beforeEach(() => {
  db = new FakeFirestore();
  vi.stubEnv("RAISE_KIT_ENABLED", "true");
  vi.stubEnv("VIZZY_RAISE_ENABLED", "true");
  vi.stubEnv("CANVAS_CONTEXT_SIGNING_KEY", "test-signing-key");
});
afterEach(() => vi.unstubAllEnvs());

describe("the agent gate", () => {
  it("is unavailable while either switch is off", async () => {
    vi.stubEnv("VIZZY_RAISE_ENABLED", "false");
    expect(await raiseAgentGate(req(signCanvasContext(ACME)))).toMatchObject({ ok: false, result: { status: 503, body: { error: "unavailable" } } });
    vi.stubEnv("VIZZY_RAISE_ENABLED", "true");
    vi.stubEnv("RAISE_KIT_ENABLED", "");
    expect(await raiseAgentGate(req(signCanvasContext(ACME)))).toMatchObject({ ok: false, result: { status: 503 } });
  });

  it("needs the canvas key and a good token, and a member may read", async () => {
    const token = signCanvasContext(ACME_MEMBER);
    vi.stubEnv("CANVAS_CONTEXT_SIGNING_KEY", "");
    expect(await raiseAgentGate(req(token))).toMatchObject({ ok: false, result: { status: 503, body: { error: "canvas_auth_unconfigured" } } });
    vi.stubEnv("CANVAS_CONTEXT_SIGNING_KEY", "test-signing-key");
    expect(await raiseAgentGate(req(`${token}x`))).toMatchObject({ ok: false, result: { status: 401, body: { error: "unauthorized" } } });
    const ok = await raiseAgentGate(req(token), { limited: async () => false });
    expect(ok).toMatchObject({ ok: true, ctx: { tenantId: "ten_acme", role: "member" } });
    expect(await raiseAgentGate(req(token), { limited: async () => true })).toMatchObject({ ok: false, result: { status: 429, body: { error: "rate_limited" } } });
  });
});

describe("reading decks for Vizzy", () => {
  it("says there are none yet", async () => {
    expect(await agentRaiseDocs(ACME, null, deps())).toEqual({ status: 200, body: { docs: [], note: expect.stringContaining("No decks yet") } });
  });

  it("lists the decks when there are several, newest first", async () => {
    const a = await make(ACME, "First");
    const b = await make(ACME, "Second", undefined, new Date("2026-11-27T10:00:00.000Z"));
    const r = await agentRaiseDocs(ACME, null, deps());
    expect(r.status).toBe(200);
    expect((r.body as { docs: Array<{ id: string; link: string }> }).docs.map((d) => [d.id, d.link])).toEqual([
      [b.id, `/admin/raise/${b.id}`],
      [a.id, `/admin/raise/${a.id}`],
    ]);
  });

  it("reads the only deck, or one by id, with each number rendered from its block, its label and its meaning", async () => {
    const doc = await make(ACME, "Acme pre-seed", (s) =>
      s.map((x, i) =>
        i === 9 ? { ...x, layout: "ask", headline: "Raising {{mb_bbbbbbbb}} to reach 40 shops", blocks: [typedBlock({ id: "mb_bbbbbbbb", name: "Raising", value: 250000, unit: "money" }, { typedBy: "usr_admin", saidInChat: true, quote: "£250,000" }, NOW)] } : x,
      ),
    );
    const only = await agentRaiseDocs(ACME, null, deps());
    const byId = await agentRaiseDocs(ACME, doc.id, deps());
    expect(only).toEqual(byId);
    const body = byId.body as { doc: { slides: Array<Record<string, unknown>>; link: string; status: string; checks: string[]; talk: unknown; versions: unknown[]; olderVersions: number }; meanings: Record<string, unknown>; numbers: unknown; note: string };
    expect(body.doc).toMatchObject({ id: doc.id, kindLabel: "Investor deck, pre-seed", status: "draft", version: 1, link: `/admin/raise/${doc.id}` });
    expect(body.doc.slides[3]).toMatchObject({
      n: 4,
      headline: "4,310 sign-ups in 12 weeks to 26 Nov",
      blocks: [{ id: "mb_aaaaaaaa", meaning: "waitlistSignups", display: "4,310", value: 4310, label: "Seen by YouGrow, 26 Nov", source: "insights" }],
    });
    expect(body.doc.slides[9]).toMatchObject({ headline: "Raising £250,000 to reach 40 shops", blocks: [{ label: "Typed by you, 26 Nov", source: "typed", saidInChat: true, currency: "GBP" }] });
    // A figure typed straight into the words is a check Vizzy can see.
    expect(body.doc.slides[9]!.checks).toEqual(['A number with no source: "40". Insert a number or type it as Typed by you.']);
    expect(body.doc.versions).toEqual([{ n: 1, note: "First draft by Vizzy.", by: "Vizzy", at: NOW.toISOString() }]);
    // None left out yet: Vizzy says so when the deck has more changes than it is shown.
    expect(body.doc.olderVersions).toBe(0);
    expect(Object.keys(body.meanings).sort()).toEqual(["talkSeconds", "waitlistSignups"]);
    expect(body.numbers).toEqual({ signups: true, growth: true, launches: null });
    expect(body.note).toMatch(/never write a figure yourself/);
  });

  it("never finds another brand's deck", async () => {
    const theirs = await make(FERNHILL, "Fernhill lender pack");
    expect(await agentRaiseDocs(ACME, theirs.id, deps())).toEqual({ status: 404, body: { error: "doc_not_found" } });
    expect(await agentRaiseDocs(ACME, "not-an-id", deps())).toEqual({ status: 404, body: { error: "doc_not_found" } });
    expect(await agentRaiseDocs(ACME, null, deps())).toMatchObject({ body: { docs: [] } });
  });
});
