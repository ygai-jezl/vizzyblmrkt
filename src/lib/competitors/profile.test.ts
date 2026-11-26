import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import type { CompetitorArticle } from "@/lib/types/competitor";
import { competitorProfiles, focusAgainst, profileLine, type ProfileInput } from "./profile";

// Made-up competitors and articles. Today is 26 Nov: the 90 days start on 28 Aug.
const NOW = Date.parse("2026-11-26T12:00:00Z");
let n = 0;
const art = (competitorId: string, over: Partial<CompetitorArticle> = {}): CompetitorArticle =>
  ({
    id: `${competitorId}_a${String(++n).padStart(3, "0")}`,
    competitorId,
    url: `https://${competitorId}.test/blog/${n}`,
    title: `Article ${n}`,
    status: "read",
    readBy: "direct",
    publishedAt: "2026-11-01",
    readAt: "2026-11-20T00:00:00.000Z",
    angle: "",
    format: "guide",
    stage: "awareness",
    situationIds: [],
    subjectIds: [],
    newTopic: null,
    asks: [],
    links: [],
    stats: [],
    sources: [],
    reader: { roles: [], companies: "", pains: [] },
    mentions: { you: [], others: [], products: [] },
    trust: { author: null, authorUrl: null, publishedAt: null, updatedAt: null, schemaTypes: [] },
    ...over,
  }) as CompetitorArticle;

const stat = { figure: "40%", about: "of buyers", quote: "40% of buyers", theirOwn: false, source: null };
const ask = (kind: "demo" | "trial") => ({ kind, placement: "end" as const, url: "https://rival.test/demo", text: "Book" });

const base: Omit<ProfileInput, "articles"> = {
  competitors: [
    { id: "cmp_rival", name: "Rivalco" },
    { id: "cmp_peer", name: "Peerly" },
  ],
  situations: [
    { id: "sit_aaaaaa01", text: "Buyers now ask a chat assistant first", questions: 12, answered: 3 },
    { id: "sit_aaaaaa02", text: "An agency packages it into a retainer", questions: 9, answered: 0 },
    { id: "sit_aaaaaa03", text: "Nobody writes on this one", questions: 4, answered: 0 },
  ],
  alternatives: [
    { name: "Bigsuite", aliases: ["Big Suite"] },
    { name: "Peerly", aliases: [] },
  ],
  nowMs: NOW,
};

describe("competitor profiles", () => {
  it("counts the last 90 days only: an article on the first day counts, one the day before doesn't", () => {
    const v = competitorProfiles({
      ...base,
      articles: [
        art("cmp_rival", { publishedAt: "2026-08-28" }),
        art("cmp_rival", { publishedAt: "2026-08-27" }),
        // No publishing day: the day we read it.
        art("cmp_rival", { publishedAt: null, readAt: "2026-08-28T09:00:00.000Z" }),
        art("cmp_rival", { publishedAt: null, readAt: "2026-08-27T23:00:00.000Z" }),
        // Not read, or not a competitor the brand watches: never counted.
        art("cmp_rival", { status: "failed" }),
        art("cmp_gone"),
      ],
    });
    expect(v.days).toBe(90);
    expect(v.since).toBe("2026-08-28");
    expect(v.profiles.map((p) => [p.name, p.read])).toEqual([
      ["Rivalco", 2],
      ["Peerly", 0],
    ]);
  });

  it("counts stats, asks and names you over the articles read from their own pages, and says how many those are", () => {
    const v = competitorProfiles({
      ...base,
      articles: [
        art("cmp_rival", { stats: [stat, stat], asks: [ask("demo")], mentions: { you: ["Acme"], others: [], products: [] } }),
        art("cmp_rival", { stats: [stat], asks: [ask("demo")] }),
        // Through Google: no stats, asks or names, so it isn't counted over for them.
        art("cmp_rival", { readBy: "google", mentions: { you: ["Acme"], others: ["Bigsuite"], products: [] } }),
      ],
    });
    const p = v.profiles[0]!;
    expect(p).toMatchObject({ read: 3, fromPage: 2, namesYou: 1 });
    expect(p.totals.stats.total).toBe(3);
    expect(p.totals.asks).toEqual([{ key: "demo", count: 2 }]);
    expect(p.namesOthers).toEqual([]);
    expect(profileLine(p)).toBe("Mostly guides, for people just learning. 3 stats, pushes demos, in the 2 of 3 read from their own pages. 1 of 2 name you.");
    // All through Google: it says so, rather than showing none.
    const google = competitorProfiles({ ...base, articles: [art("cmp_peer", { readBy: "google", format: "case_study", stage: "consideration", reader: { roles: [], companies: "agencies", pains: [] } })] });
    expect(profileLine(google.profiles[1]!)).toBe("Mostly case studies, for agencies. Read through Google, so no stats or asks.");
  });

  it("gives each one's top 3 situations, 2 newest angles and 2 articles to stand on, and the alternatives they name that you don't watch", () => {
    const v = competitorProfiles({
      ...base,
      articles: [
        art("cmp_rival", { publishedAt: "2026-11-10", angle: "Newest angle", situationIds: ["sit_aaaaaa01", "sit_gone"], mentions: { you: [], others: ["Big Suite", "Peerly"], products: [] } }),
        art("cmp_rival", { publishedAt: "2026-11-05", angle: "Second angle", situationIds: ["sit_aaaaaa01"], mentions: { you: [], others: ["Bigsuite"], products: [] } }),
        art("cmp_rival", { publishedAt: "2026-10-01", angle: "Oldest angle", situationIds: ["sit_aaaaaa02"] }),
        art("cmp_peer", { publishedAt: "2026-11-02", situationIds: ["sit_aaaaaa02"] }),
      ],
    });
    const p = v.profiles[0]!;
    expect(p.situations).toEqual([
      { id: "sit_aaaaaa01", text: "Buyers now ask a chat assistant first", count: 2 },
      { id: "sit_aaaaaa02", text: "An agency packages it into a retainer", count: 1 },
    ]);
    expect(p.angles).toEqual(["Newest angle", "Second angle"]);
    expect(p.proof.map((x) => x.url)).toEqual([expect.stringMatching(/^https:\/\/cmp_rival\.test\/blog\//), expect.stringMatching(/^https:\/\/cmp_rival\.test\/blog\//)]);
    // Peerly is watched, so only Bigsuite counts, once per article whatever the spelling.
    expect(p.namesOthers).toEqual([{ name: "Bigsuite", count: 2 }]);
    expect(v.namedNotWatched).toEqual([{ name: "Bigsuite", count: 2 }]);
  });

  it("sets each situation's articles against the questions answered, with a flag and the number since approval", () => {
    const v = competitorProfiles({
      ...base,
      since: "2026-11-03",
      articles: [
        art("cmp_rival", { publishedAt: "2026-11-10", situationIds: ["sit_aaaaaa01"] }),
        art("cmp_rival", { publishedAt: "2026-11-01", situationIds: ["sit_aaaaaa01"] }),
        art("cmp_peer", { publishedAt: "2026-11-04", situationIds: ["sit_aaaaaa01"] }),
        art("cmp_peer", { publishedAt: "2026-11-04", situationIds: ["sit_aaaaaa02"] }),
      ],
    });
    expect(v.situations.map((s) => [s.id, s.they, s.byCompetitor.map((b) => `${b.name} ${b.count}`), `${s.answered} of ${s.questions}`, s.flag, s.newSince])).toEqual([
      ["sit_aaaaaa01", 3, ["Rivalco 2", "Peerly 1"], "3 of 12", "you_lead", 2],
      ["sit_aaaaaa02", 1, ["Peerly 1"], "0 of 9", "gap", 1],
      ["sit_aaaaaa03", 0, [], "0 of 4", "open", 0],
    ]);
    expect(competitorProfiles({ ...base, articles: [] }).situations[0]!.newSince).toBeNull();
  });

  it("picks the focus to set against them: approved, else the draft's, else the 5 they write on most", () => {
    const v = competitorProfiles({ ...base, articles: [art("cmp_rival", { situationIds: ["sit_aaaaaa02"] })] });
    expect(focusAgainst(v.situations, { approved: ["sit_aaaaaa03", "sit_aaaaaa01"], draft: ["sit_aaaaaa02"] })).toMatchObject({ from: "approved", rows: [{ id: "sit_aaaaaa03" }, { id: "sit_aaaaaa01" }] });
    expect(focusAgainst(v.situations, { approved: [], draft: ["sit_aaaaaa02"] })).toMatchObject({ from: "draft", rows: [{ id: "sit_aaaaaa02" }] });
    expect(focusAgainst(v.situations, { approved: ["sit_gone0001"], draft: [] })).toMatchObject({ from: "busiest", rows: [{ id: "sit_aaaaaa02" }] });
  });

  it("writes its line in house style, and none for a competitor with nothing read", () => {
    const v = competitorProfiles({
      ...base,
      articles: [art("cmp_rival", { format: "news", situationIds: ["sit_aaaaaa01"], stats: [stat], asks: [ask("trial")] }), art("cmp_rival", { format: "research" })],
    });
    const line = profileLine(v.profiles[0]!);
    expect(line).toBe('Mostly news posts and research pieces, for people just learning. 1 stat, pushes free trials. Most on "Buyers now ask a chat assistant first".');
    expect([...dashesIn(line), ...aiTellsIn(line)]).toEqual([]);
    expect(profileLine(v.profiles[1]!)).toBe("");
  });
});
