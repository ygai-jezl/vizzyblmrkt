import { describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { KnowledgeCollectionLike, TenantContext } from "@/lib/tenant/types";
import { BlogBriefSchema, type ContentPlan } from "@/lib/types/contentPlan";
import { createNote, getNote, listNotes } from "@/lib/brandNotes/store";
import { ADDED_BY_YOU, keepArticleSeen, matchSeen, parseAsks, parseVerdicts, type SeenDeps } from "./seen";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken" };
const plan = { name: "Visibility", scope: { spark: "Weekly is enough for most teams.", topics: [], industryLens: "" } } as unknown as ContentPlan;
const brief = (over: Record<string, unknown> = {}) =>
  BlogBriefSchema.parse({ primaryQuestion: "How often should you check your AI search visibility?", subjectId: "sub_cadence", ...over });

async function setup() {
  const db = new FakeFirestore();
  const base: SeenDeps = { db, embed: vi.fn(async (items: unknown[]) => items.map(() => [0.1])) };
  const make = async (text: string, subjectIds: string[] = []) => {
    const r = await createNote(A, { text, kind: "tested", subjectIds, canName: false }, { source: "typed" }, base);
    if (!r.ok) throw new Error("not made");
    return r.value;
  };
  const linked = await make("We checked daily for a month and stopped reading the results.", ["sub_cadence"]);
  const close = await make("A brand dropped out of answers for two weeks after a rival's page.");
  const same = await make("Teams track their own name only.");
  const far = await make("Our onboarding call takes twenty minutes.");
  const rows = [close, same, far, linked].map((n, i) => ({ tenantId: "ten_A", kind: "note", ref: n.id, status: "kept", _distance: 0.1 + i * 0.05 }));
  const vectors: KnowledgeCollectionLike = {
    where: () => vectors,
    findNearest: () => ({ get: async () => ({ empty: false, size: rows.length, docs: rows.map((r, i) => ({ id: `v${i}`, data: () => r })) }) }),
  };
  return { db, base, linked, close, same, far, vectors };
}

/** A model that rates notes by what they say, and writes three questions when asked for them. */
const model = (verdicts: Record<string, string>) =>
  vi.fn(async (prompt: string) => {
    if (prompt.includes("ASK: <the question>")) return "ASK: When have you seen answers change week to week?\nASK: What did daily checks cost you?\nASK: Which change was worth catching the same day?";
    const lines = [...prompt.matchAll(/^\[(\d+)\] (.+)$/gm)].map(([, n, text]) => {
      const key = Object.keys(verdicts).find((k) => text!.includes(k));
      return `[${n}]: ${key ? verdicts[key] : "NO"}`;
    });
    return lines.join("\n");
  });

describe("an article's notes from What we've seen", () => {
  it("puts in notes linked to its subject and notes the check calls strong; keeps weaker ones aside", async () => {
    const s = await setup();
    const generate = model({ "dropped out": "STRONG", "own name": "WEAK", onboarding: "NO" });
    const seen = await matchSeen(A, { plan, brief: brief(), brandName: "Acme" }, { ...s.base, vectors: s.vectors, query: async () => [1], generate });
    expect(seen.notes.map((n) => [n.id, n.why])).toEqual([
      [s.linked.id, "Linked to this article's subject"],
      [s.close.id, "Close in meaning, and it bears on this question"],
    ]);
    expect(seen.near.map((n) => n.id)).toEqual([s.same.id]);
    expect(seen.asks).toEqual([]);
    expect(seen.matchedFor).toBe("How often should you check your AI search visibility?");
    // The check is shown the notes as data, numbered.
    expect(String(generate.mock.calls[0]![0])).toContain("[1] A brand dropped out");
  });

  it("never puts back a note a person took out, and keeps one they added", async () => {
    const s = await setup();
    const generate = model({ "dropped out": "STRONG" });
    const seen = await matchSeen(
      A,
      {
        plan,
        brief: brief({ seen: { removed: [s.linked.id], notes: [{ id: s.far.id, text: s.far.text, why: ADDED_BY_YOU }] } }),
        brandName: "Acme",
      },
      { ...s.base, vectors: s.vectors, query: async () => [1], generate },
    );
    expect(seen.notes.map((n) => n.id)).toEqual([s.far.id, s.close.id]);
    expect(seen.removed).toEqual([s.linked.id]);
  });

  it("puts nothing close in meaning in by itself when the check doesn't answer", async () => {
    const s = await setup();
    const seen = await matchSeen(A, { plan, brief: brief({ subjectId: null }), brandName: "Acme" }, {
      ...s.base,
      vectors: s.vectors,
      query: async () => [1],
      generate: async () => null,
    });
    expect(seen.notes).toEqual([]);
    expect(seen.near.length).toBeGreaterThan(0);
    expect(seen.asks).toEqual([]);
  });

  it("asks three questions for the article when nothing matches", async () => {
    const s = await setup();
    const seen = await matchSeen(A, { plan, brief: brief({ subjectId: null }), brandName: "Acme" }, {
      ...s.base,
      vectors: s.vectors,
      query: async () => null,
      generate: model({}),
    });
    expect(seen.notes).toEqual([]);
    expect(seen.asks).toHaveLength(3);
  });

  it("reads the check's and the questions' lines", () => {
    expect(parseVerdicts("[1]: STRONG\n2: weak\n**[3]**: NO\n[9]: STRONG", 3)).toEqual(["STRONG", "WEAK", "NO"]);
    expect(parseAsks("ASK: When did it happen?\nASK: When did it happen?\nnoise\n- ASK: Which one mattered most?")).toEqual([
      "When did it happen?",
      "Which one mattered most?",
    ]);
  });
});

describe("after an article is checked", () => {
  it("records the notes it used, and keeps what a person wrote for it as one note, updated after", async () => {
    const s = await setup();
    const ask = "When have you seen answers change week to week?";
    const first = brief({ seen: { notes: [{ id: s.close.id, text: s.close.text }], own: `${ask}\nIn March a customer vanished from answers for a fortnight.`, asks: [ask] } });
    await keepArticleSeen(A, { article: "ws1/p1", brief: first, used: true }, s.base);
    expect((await getNote(A, s.close.id, s.base))?.usedBy).toEqual(["ws1/p1"]);
    const mine = (await listNotes(A, s.base)).filter((n) => n.source === "article");
    expect(mine.map((n) => [n.text, n.sourceRef, n.subjectIds])).toEqual([["In March a customer vanished from answers for a fortnight.", "ws1/p1", ["sub_cadence"]]]);

    const again = brief({ seen: { own: "In March a customer vanished from answers for three weeks." } });
    await keepArticleSeen(A, { article: "ws1/p1", brief: again, used: true }, s.base);
    const after = (await listNotes(A, s.base)).filter((n) => n.source === "article");
    expect(after.map((n) => n.text)).toEqual(["In March a customer vanished from answers for three weeks."]);

    // Unticked: nothing new is kept.
    await keepArticleSeen(A, { article: "ws1/p2", brief: brief({ seen: { own: "Something else we saw happen twice.", save: false } }), used: true }, s.base);
    expect((await listNotes(A, s.base)).filter((n) => n.sourceRef === "ws1/p2")).toEqual([]);
  });
});
