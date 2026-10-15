import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tenant = vi.hoisted(() => ({ getTenantById: vi.fn(async () => ({ id: "ten_A", tenantName: "Acme", rootDomain: "acme.example", allowedOrigins: [] })) }));
vi.mock("@/lib/tenant", async (importOriginal) => ({ ...(await importOriginal<object>()), getTenantById: tenant.getTenantById }));

import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import type { TenantContext } from "@/lib/tenant/types";
import { BrandMapDecidedSchema } from "@/lib/types/brandMap";
import { reconcileWithSavedMap } from "@/lib/content/blog/mapActions";
import { authorBrandMapSuggestions } from "@/lib/canvas/kinds/brandMap";
import { agentContentContext } from "@/lib/content/agentApi";
import { agentBrandMap } from "./agentApi";
import { afterRecordsChange } from "./afterChange";
import { ensureMoved } from "./move";
import { addQuestion, createGroup, createSubject, listSubjects } from "./records";
import { createSituation, editSituation, listSituations } from "./situations";
import { readImport } from "./imports";
import { saveBrandMap } from "./store";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "usr_admin", role: "admin" };
const NOW = Date.parse("2026-10-15T10:00:00.000Z");
const quiet = { embed: async () => [], query: async () => null };

beforeEach(() => {
  __resetRateLimitState();
  for (const k of ["BRAND_MAP_ENABLED", "BRAND_MAP_CHAT_ENABLED", "BRAND_MAP_SCALE_ENABLED", "BRAND_MAP_SITUATIONS_ENABLED", "BRAND_MAP_IMPORT_ENABLED", "BRAND_MAP_RESEARCH_ENABLED", "BRAND_MAP_PAGES_ENABLED", "CREATE_BLOG_BRAND_MAP_ENABLED", "CONTENT_CHAT_AUTHORING_ENABLED"]) vi.stubEnv(k, "true");
});
afterEach(() => vi.unstubAllEnvs());

async function setup() {
  const db = new FakeFirestore();
  const deps = { db, nowMs: NOW, embed: quiet };
  await saveBrandMap(ctx, { baseRev: 0, decided: BrandMapDecidedSchema.parse({ identity: { name: "Acme", category: "AI visibility tracking" }, names: [{ id: "n_aaaaaaaa", name: "Acme Pulse", kind: "product" }] }) }, { db, nowMs: NOW });
  await ensureMoved(ctx, deps);
  const g = await createGroup(ctx, { name: "Tracking" }, deps);
  const s = await createSubject(ctx, { name: "AI answers tracking", groupId: g.ok ? g.value.id : null }, deps);
  const sid = s.ok ? s.value.id : "";
  const sit = await createSituation(ctx, { text: "The board asked what ChatGPT says about us", who: "Head of marketing" }, deps);
  const situationId = sit.ok ? sit.value.id : "";
  await addQuestion(ctx, sid, { text: "How do I see what ChatGPT says about my brand?", situationIds: [situationId] }, deps);
  await addQuestion(ctx, sid, { text: "How often do AI answers change?" }, deps);
  // As the API does after a change: counts and totals follow.
  await afterRecordsChange(ctx, { subjects: [sid] }, { db, nowMs: NOW, ...quiet });
  return { db, deps, sid, situationId };
}

describe("what Vizzy reads of a map at any size", () => {
  it("is a summary, never the whole list: what the brand is, its situations and groups with counts, what waits", async () => {
    const { db } = await setup();
    const r = await agentBrandMap(ctx, db);
    const body = r.body as { map: Record<string, unknown>; waiting: { proposals: number }; note: string };
    expect(body.map).toMatchObject({ atAnySize: true, identity: { name: "Acme" }, groups: [{ name: "Tracking", subjects: 1 }], situationsInAll: 1 });
    expect(body.map).not.toHaveProperty("subjects");
    expect((body.map.situations as Array<{ text: string }>)[0]!.text).toBe("The board asked what ChatGPT says about us");
    expect(body.note).toContain("never the whole list");
  });

  it("finds subjects near some words, and reads one subject with its questions", async () => {
    const { db, sid, situationId } = await setup();
    const found = (await agentBrandMap(ctx, db, { find: "tracking ChatGPT answers" })).body as { subjects: Array<{ id: string; name: string }> };
    expect(found.subjects.map((s) => s.name)).toEqual(["AI answers tracking"]);
    const one = (await agentBrandMap(ctx, db, { subject: sid })).body as { subject: { questions: Array<{ text: string; state: string; situationIds?: string[] }> } };
    expect(one.subject.questions.map((q) => [q.text, q.state, q.situationIds ?? []])).toEqual([
      ["How do I see what ChatGPT says about my brand?", "open", [situationId]],
      ["How often do AI answers change?", "open", []],
    ]);
    expect((await agentBrandMap(ctx, db, { subject: "sub_missing00" })).status).toBe(404);
  });

  it("says what an import of the brand's own research added", async () => {
    const { db } = await setup();
    expect((await agentBrandMap(ctx, db, { importId: "latest" })).status).toBe(404);
    await readImport(ctx, { fileName: "research.pdf", bytes: Buffer.from("%PDF-1.7\n") }, { db, nowMs: NOW, modelReady: () => true, read: async () => "SEARCH: track ai answers | 1\nASK: How often do AI answers change? | 1\nALSO: track ai answers free | 1" });
    const r = (await agentBrandMap(ctx, db, { importId: "latest" })).body as { counts: Record<string, number>; peopleAddToTheSearch: string[]; note: string };
    expect(r.counts).toMatchObject({ found: 2, onMap: 1, searches: 1 });
    expect(r.peopleAddToTheSearch).toEqual(["free"]);
    expect(r.note).toContain("Nothing from it is on the map");
  });

  it("offers only the open questions of the situations it focuses on, at most 30, to write next", async () => {
    const { db, situationId } = await setup();
    const before = (await agentContentContext(ctx, {}, db)).body as { brandMap: { subjects: unknown[] } };
    expect(before.brandMap.subjects).toEqual([]);
    const sit = (await listSituations(ctx, { db }))[0]!;
    await editSituation(ctx, situationId, { baseRev: sit.rev, focus: true }, { db, nowMs: NOW, embed: quiet });
    const after = (await agentContentContext(ctx, {}, db)).body as { brandMap: { subjects: Array<{ name: string; questions: Array<{ text: string; situationId: string }> }> } };
    expect(after.brandMap.subjects).toEqual([
      { id: expect.any(String), name: "AI answers tracking", questions: [{ id: expect.any(String), text: "How do I see what ChatGPT says about my brand?", state: "open", situationId }] },
    ]);
  });
});

describe("what Vizzy proposes on a map at any size", () => {
  const author = (input: Record<string, unknown>, db: FakeFirestore, extra: Record<string, unknown> = {}) =>
    authorBrandMapSuggestions({ ctx, input, brief: "From our chat" }, { db, nowMs: NOW, ...extra });

  it("proposes buying situations and questions linked to one, and says nothing on the map changed", async () => {
    const { db, situationId } = await setup();
    const r = await author(
      {
        mode: "add",
        situationId,
        changes: [{ type: "add_question", subject: "AI answers tracking", text: "How do I report AI visibility to the board?", intent: "how_to" }],
        situations: [{ text: "A competitor keeps coming up in AI answers", who: "Head of marketing" }],
      },
      db,
    );
    expect(r).toMatchObject({ ok: true, status: "suggested" });
    if (!r.ok) return;
    expect(r.summary).toContain("Add a buying situation: “A competitor keeps coming up in AI answers”");
    expect(r.summary).toContain("Nothing in the map has changed");
    expect((await listSituations(ctx, { db })).map((s) => [s.text, s.status, s.from])).toContainEqual(["A competitor keeps coming up in AI answers", "proposed", "vizzy"]);
    const proposed = await listSubjects(ctx, {}, { db });
    expect(proposed.map((s) => s.name)).toContain("AI answers tracking");
  });

  it("researches the situations people are in, or what people in one ask, only with situations on", async () => {
    const { db, situationId } = await setup();
    vi.stubEnv("BRAND_MAP_SITUATIONS_ENABLED", "false");
    expect(await author({ mode: "situations" }, db)).toMatchObject({ ok: false, status: 503, error: "situations_disabled" });
    vi.stubEnv("BRAND_MAP_SITUATIONS_ENABLED", "true");
    const grounded = vi.fn(async () => ({ text: "Q: Which AI engines should a brand watch first? | how_to | NEW: Engine coverage", model: "m", sources: [], supports: [] }));
    const r = await author({ mode: "situation_questions", situationId }, db, { ask: { modelReady: () => true, grounded, embed: quiet } });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.summary).toBe("Proposed 1 question people in that situation ask (1 on new subjects): “Which AI engines should a brand watch first?”. Nothing else on the map has changed: an admin adds the questions on Brand › Brand map.");
    expect(await author({ mode: "situation_questions" }, db)).toMatchObject({ ok: false, status: 400 });
  });

  it("checks a situation Vizzy names for a new article against the map", async () => {
    const { db, situationId } = await setup();
    expect(await reconcileWithSavedMap(ctx, { situationId }, { db })).toEqual({ situationId });
    expect(await reconcileWithSavedMap(ctx, { situationId: "sit_notthere00" }, { db })).toEqual({});
  });
});
