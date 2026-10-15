import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import { ensureMoved } from "./move";
import { addQuestion, createSubject, listSubjects } from "./records";
import { askSituationQuestions, parseQuestionLines } from "./situationQuestions";
import { createSituation, readSituation } from "./situations";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const NOW = Date.parse("2026-10-15T10:00:00.000Z");
// No meaning to be had: the nearest subjects come from shared words.
const embed = { embed: async () => [], query: async () => null };

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_SITUATIONS_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("reading the questions a situation's people ask", () => {
  it("places each by a subject's number or a new subject, keeps two comparisons at most, and drops addresses", () => {
    const text = [
      "Q: How do I see what ChatGPT says about my brand? | how to | S1",
      "Q: Do we need an llms.txt file? | other | NEW: AI crawlers and llms.txt",
      "Q: Acme vs Rivalco? | comparison | S2",
      "Q: Acme vs Peec? | comparison | S2",
      "Q: Rivalco vs Peec? | comparison | S2",
      "Q: Where's the guide at https://x.example/a? | other | S1",
      "Q: How do I see what ChatGPT says about my brand? | how_to | S1",
      "Q: Which tool fits? | alternatives | S9",
    ].join("\n");
    expect(parseQuestionLines(text, 2)).toEqual([
      { text: "How do I see what ChatGPT says about my brand?", intent: "how_to", place: { n: 1 } },
      { text: "Do we need an llms.txt file?", intent: "other", place: { name: "AI crawlers and llms.txt" } },
      { text: "Acme vs Rivalco?", intent: "comparison", place: { n: 2 } },
      { text: "Acme vs Peec?", intent: "comparison", place: { n: 2 } },
    ]);
    expect(parseQuestionLines(Array.from({ length: 20 }, (_, i) => `Q: Question number ${i}? | other | S1`).join("\n"), 1)).toHaveLength(15);
  });
});

describe("what people in a situation ask", () => {
  it("proposes each question on a near subject or a new one, and links one the map has already", async () => {
    const db = new FakeFirestore();
    const deps = { db, nowMs: NOW, embed };
    await ensureMoved(ctx, deps);
    const monitoring = await createSubject(ctx, { name: "AI answers monitoring" }, deps);
    const reporting = await createSubject(ctx, { name: "Brand reporting" }, deps);
    const changes = await addQuestion(ctx, monitoring.ok ? monitoring.value.id : "", { text: "How often do AI answers change?" }, deps);
    const sit = await createSituation(ctx, { text: "We need to see what AI answers say about our brand", who: "Head of marketing" }, deps);
    const sid = sit.ok ? sit.value.id : "";

    const grounded = vi.fn(async (prompt: string) => {
      const n = new Map([...prompt.matchAll(/^S(\d+)\. (.+)$/gm)].map((m) => [m[2]!, m[1]]));
      return {
        text: [
          `Q: How do I see what ChatGPT says about my brand? | how_to | S${n.get("AI answers monitoring")}`,
          `Q: How do I report AI visibility to the board? | how_to | S${n.get("Brand reporting")}`,
          "Q: Do we need an llms.txt file? | other | NEW: AI crawlers and llms.txt",
          "Q: Which AI crawlers should we allow? | other | NEW: ai crawlers AND llms.txt",
          `Q: How often do AI answers change? | other | S${n.get("AI answers monitoring")}`,
        ].join("\n"),
        model: "m",
        sources: [],
        supports: [],
      };
    });
    const r = await askSituationQuestions(ctx, sid, { ...deps, modelReady: () => true, grounded: grounded as never });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.questions.map((q) => [q.text, q.subjectName, q.status, q.newSubject, q.linked])).toEqual([
      ["How do I see what ChatGPT says about my brand?", "AI answers monitoring", "proposed", false, false],
      ["How do I report AI visibility to the board?", "Brand reporting", "proposed", false, false],
      ["Do we need an llms.txt file?", "AI crawlers and llms.txt", "proposed", true, false],
      // The same new subject by its folded name: one subject, not two.
      ["Which AI crawlers should we allow?", "AI crawlers and llms.txt", "proposed", true, false],
      ["How often do AI answers change?", "AI answers monitoring", "decided", false, true],
    ]);
    expect(grounded.mock.calls[0]![0]).toContain("“We need to see what AI answers say about our brand”");
    // The new subject is proposed, in no group.
    expect((await listSubjects(ctx, { status: "proposed" }, { db })).map((s) => [s.name, s.groupId, s.from])).toEqual([["AI crawlers and llms.txt", null, "situations"]]);
    // The question the map had is linked to the situation too.
    expect((await brandMapRecords(ctx, db).get("q", changes.ok ? changes.value.id : ""))?.situationIds).toEqual([sid]);
    expect((await readSituation(ctx, sid, deps))?.questions).toHaveLength(5);
    expect(reporting.ok).toBe(true);
  });

  it("says when the situation has gone, and when nothing usable came back", async () => {
    const db = new FakeFirestore();
    const deps = { db, nowMs: NOW, embed };
    await ensureMoved(ctx, deps);
    expect(await askSituationQuestions(ctx, "sit_missing01", { ...deps, modelReady: () => true })).toEqual({ ok: false, status: 404, error: "no_situation" });
    const sit = await createSituation(ctx, { text: "We're setting next year's search budget" }, deps);
    const empty = vi.fn(async () => ({ text: "Nothing.", model: "m", sources: [], supports: [] }));
    expect(await askSituationQuestions(ctx, sit.ok ? sit.value.id : "", { ...deps, modelReady: () => true, grounded: empty as never })).toEqual({ ok: false, status: 502, error: "research_failed" });
  });
});
