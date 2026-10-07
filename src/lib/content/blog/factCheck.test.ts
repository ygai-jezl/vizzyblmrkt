import { describe, expect, it, vi } from "vitest";
import { BlogArticleMetaSchema, type ContentNode, type ContentPlan } from "@/lib/types/contentPlan";
import { applyCorrections, checkBlogFacts, parseCorrections, type FactCheckInput } from "./factCheck";
import { SAMPLE_BRIEF } from "./testing/sampleArticle";

const BODY = [
  "# What is AI search visibility monitoring?",
  "",
  "*Last updated: 2026-10-07*",
  "",
  "Acme Visibility has four plans. The Starter plan includes sentiment tracking and 500 prompts. Every plan has a trial.",
  "",
  "- Rivalco is a platform focused on enterprise reporting.",
  "- Acme Visibility is an alternative to Rivalco.",
  "",
  "| Plan | Includes |",
  "| --- | --- |",
  "| Enterprise | Dedicated support and custom limits |",
  "",
  "## How accurate is it?",
  "",
  "Tracking achieves high accuracy by sampling each prompt.",
].join("\n");

const node = (body = BODY, over: Partial<ContentNode> = {}) =>
  ({ id: "hub", type: "hub", channel: "blog", role: "Hub", brief: "Explain it.", body, warnings: [], status: "generated", ...over }) as unknown as ContentNode;
const plan = {
  id: "p1",
  name: "Visibility guide",
  strategy: { objective: "brand_visibility", hubUrl: null, subscriberCount: null },
  scope: { topics: [], spark: "Buyers ask AI assistants for shortlists.", industryLens: "" },
  knowledge: { groundingScope: "global", proofAssets: [] },
} as unknown as ContentPlan;

const input = (over: Partial<FactCheckInput> = {}): FactCheckInput => ({
  plan,
  node: node(),
  brief: SAMPLE_BRIEF,
  brandName: "Acme",
  knowledgeContext: "[Source: Pricing — https://acme.example/pricing]\nAcme Visibility has four plans. Every plan has a trial.",
  knowledgeUrls: ["https://acme.example/pricing"],
  proofBlock: "",
  ...over,
});
const now = () => new Date("2026-10-07T10:00:00.000Z");

const CHECKER = [
  "OLD: The Starter plan includes sentiment tracking and 500 prompts.",
  "NEW: DELETE",
  "WHY: plan contents not stated",
  "OLD: - Rivalco is a platform focused on enterprise reporting.",
  "NEW: DELETE",
  "WHY: nothing given about Rivalco",
  "OLD: | Enterprise | Dedicated support and custom limits |",
  "NEW: | Enterprise | Includes a trial |",
  "WHY: plan contents not stated",
  "OLD: Tracking achieves high accuracy by sampling each prompt.",
  "NEW: Tracking samples each prompt, because answers vary from run to run.",
  "WHY: accuracy not claimed",
  "OLD: A sentence that is not in the article at all.",
  "NEW: Something else.",
  "WHY: misquoted",
].join("\n");

describe("the blog fact check", () => {
  it("reads the checker's corrections, and nothing from a plain OK", () => {
    const got = parseCorrections(CHECKER);
    expect(got).toHaveLength(5);
    expect(got[0]).toEqual({ old: "The Starter plan includes sentiment tracking and 500 prompts.", next: "", why: "plan contents not stated" });
    expect(got[3]!.next).toBe("Tracking samples each prompt, because answers vary from run to run.");
    expect(parseCorrections("OK")).toEqual([]);
    expect(parseCorrections("Everything looks supported to me.")).toEqual([]);
    // An OLD with no NEW is not a correction.
    expect(parseCorrections("OLD: something\nWHY: because")).toEqual([]);
  });

  it("applies a correction only where its text is in the copy, and never grows the copy", () => {
    const { body, applied } = applyCorrections(BODY, parseCorrections(CHECKER));
    // One sentence of three is taken out and the gap closed.
    expect(body).toContain("Acme Visibility has four plans. Every plan has a trial.");
    // A list item that is wholly wrong goes, line and all; its neighbour stays.
    expect(body).not.toContain("enterprise reporting");
    expect(body).toContain("\n\n- Acme Visibility is an alternative to Rivalco.\n");
    // A table row stays a row.
    expect(body).toContain("| Enterprise | Includes a trial |");
    expect(body).toContain("Tracking samples each prompt, because answers vary from run to run.");
    expect(applied.map((c) => c.reason)).toEqual([
      "plan contents not stated",
      "nothing given about Rivalco",
      "plan contents not stated",
      "accuracy not claimed",
    ]);
    expect(applied[0]).toMatchObject({ after: "" });

    // Not guessed at, not allowed to balloon, and a heading is not a claim.
    const refused = applyCorrections(BODY, [
      { old: "Every plan has a trial.", next: "Every plan has a trial. ".repeat(20), why: "padding" },
      { old: "## How accurate is it?", next: "## It is very accurate", why: "heading" },
      { old: "short", next: "x", why: "too short to place" },
    ]);
    expect(refused).toEqual({ body: BODY, applied: [] });
  });

  it("checks the copy against the material, applies what it finds and keeps a record", async () => {
    const generate = vi.fn(async (_prompt: string, _opts: { timeoutMs: number; temperature?: number }) => CHECKER);
    const r = await checkBlogFacts(input(), { generate, now });
    expect(r).toMatchObject({ checked: true, corrected: 4 });
    expect(r.body).not.toContain("500 prompts");
    expect(r.meta.checkedAt).toBe("2026-10-07T10:00:00.000Z");
    expect(r.meta.corrections).toHaveLength(4);
    // "500" was an untraceable figure before the check; it is gone after.
    expect(r.meta.unsupportedFigures).toEqual([]);

    const prompt = String(generate.mock.calls[0]![0]);
    expect(prompt).toContain("each sentence holding one must change: 500");
    expect(prompt).toContain("<material>\n[Source: Pricing — https://acme.example/pricing]");
    expect(prompt).toContain("Cite as [Example Research, 2026](https://research.example.org/buyers-2026)");
    expect(prompt).not.toContain("blocked.example.io"); // an unverified source is not material
    // Naming an alternative the brief lists is not a claim to strike out.
    expect(prompt).toContain("Rivalco — an alternative in the category");
    expect(prompt).toContain("Today is 2026-10-07.");
    expect(generate.mock.calls[0]![1]).toMatchObject({ temperature: 0, thinkingBudget: 4096 });
  });

  it("never lets the checker touch the date the system stamped", async () => {
    const r = await checkBlogFacts(input(), {
      generate: async () => "OLD: *Last updated: 2026-10-07*\nNEW: DELETE\nWHY: date not in material",
      now,
    });
    expect(r.body).toContain("*Last updated: 2026-10-07*");
    expect(r.corrected).toBe(0);
  });

  it("does not let a correction bring in a link or a figure of its own", async () => {
    const sneaky = [
      "OLD: Tracking achieves high accuracy by sampling each prompt.",
      "NEW: Tracking is 99.9% accurate, see [this study](https://made-up.example.com/s).",
      "WHY: more specific",
    ].join("\n");
    const r = await checkBlogFacts(input(), { generate: async () => sneaky, now });
    expect(r.body).toContain("Tracking is 99.9% accurate, see this study.");
    expect(r.meta.removedLinks).toEqual(["https://made-up.example.com/s"]);
    expect(r.meta.unsupportedFigures).toEqual(["500", "99.9%"]);
  });

  it("stamps a clean check, adds to an earlier record, and leaves the copy alone when the checker is down", async () => {
    const earlier = BlogArticleMetaSchema.parse({ metaTitle: "Kept", corrections: [{ before: "old claim", after: "", reason: "earlier" }] });
    const clean = await checkBlogFacts(input({ node: node(BODY, { blog: earlier }) }), { generate: async () => "OK", now });
    expect(clean).toMatchObject({ checked: true, corrected: 0, body: BODY });
    expect(clean.meta).toMatchObject({ metaTitle: "Kept", checkedAt: "2026-10-07T10:00:00.000Z" });
    expect(clean.meta.corrections).toHaveLength(1);

    const again = await checkBlogFacts(input({ node: node(BODY, { blog: earlier }) }), { generate: async () => CHECKER, now });
    expect(again.meta.corrections.map((c) => c.reason)).toEqual([
      "plan contents not stated",
      "nothing given about Rivalco",
      "plan contents not stated",
      "accuracy not claimed",
      "earlier",
    ]);

    const down = await checkBlogFacts(input(), { generate: async () => null, now });
    expect(down).toMatchObject({ checked: false, corrected: 0, body: BODY });
    expect(down.meta.checkedAt).toBeNull();
  });
});
