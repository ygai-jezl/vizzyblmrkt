import { describe, expect, it } from "vitest";
import { QUESTION_TITLE } from "@/lib/brandNotes/store";
import { ARTICLES, GROUPS, measure, OLD_QUESTION_TITLE, reportLines, SUBJECTS, type Embedder } from "./questionDupes";

// scripts/measure-question-dupes.ts: each side embedded as its reader embeds it, on each model (ADR-0023).

describe("the calibration groups", () => {
  it("titles each side as the old store and brand search's indexer do", () => {
    expect(OLD_QUESTION_TITLE).toBe(QUESTION_TITLE);
    const [proposal, onMap] = SUBJECTS.repeats[0]!;
    expect(proposal.as.old).toEqual({ task: "document", title: "Subject" });
    expect(onMap.as.new).toEqual({ task: "document", title: "Repotting a fiddle leaf fig" });
    expect(onMap.texts?.new).toBe("Repotting a fiddle leaf fig\n\nWhen should I repot a fiddle leaf fig?\n\nWhat size pot does a fiddle leaf fig need?");
    expect(onMap.texts?.old).toBe("Repotting a fiddle leaf fig\nWhen should I repot a fiddle leaf fig?\nWhat size pot does a fiddle leaf fig need?");
    for (const g of GROUPS) expect(g.repeats.length && g.apart.length, g.name).toBeTruthy();
    const [question, article] = ARTICLES.repeats[0]!;
    expect(question.as).toEqual({ old: { task: "query" }, new: { task: "query" } });
    expect(article.as).toEqual({ old: { task: "document", title: "Competitor article" }, new: { task: "document", title: "Leafy Shop: How to repot a fiddle leaf fig" } });
    expect(article.texts?.new.startsWith("Repot in spring")).toBe(true);
  });

  it("embeds queries as queries and documents with their titles, per model, and reports each group", async () => {
    const seen: Array<{ task: string; title?: string }> = [];
    // Close pairs share their first word; others don't.
    const embed: Embedder = async (items, task) =>
      items.map((i) => {
        seen.push({ task, title: i.title });
        const w = i.content.toLowerCase().split(/\W+/).filter(Boolean)[0] ?? "";
        return [w.length % 3, w.length % 5, 1];
      });
    const lines = await measure(GROUPS.slice(0, 1), "new", embed);
    expect(lines[1]).toBe("Subject against subject, new model: LOOKS_LIKE (src/lib/brandMap/embed.ts)");
    expect(seen.every((s) => s.task === "document" && s.title && s.title !== "Subject")).toBe(true);
    await measure(GROUPS.slice(0, 1), "old", embed);
    expect(seen.some((s) => s.title === "Subject")).toBe(true);
  });

  it("says where a cut-off separates the groups, or that none does", () => {
    const group = { name: "G", cutOff: "X" };
    expect(reportLines(group, "new", [0.9, 0.95], [0.5, 0.7])[3]).toBe("  separated: any cut-off between 0.700 and 0.900 (midpoint 0.800)");
    expect(reportLines(group, "old", [0.6, 0.95], [0.5, 0.7])[3]).toBe("  OVERLAP: no cut-off separates them (lowest close 0.600, highest different 0.700)");
  });

  it("refuses to report when the model gives no vector", async () => {
    await expect(measure(GROUPS.slice(0, 1), "new", async (items) => items.map(() => null))).rejects.toThrow("embedding failed");
  });
});
