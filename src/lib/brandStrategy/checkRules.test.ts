import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import type { CompetitorArticle } from "@/lib/types/competitor";
import { StrategyCheckSchema, type StrategyCheck } from "@/lib/types/brandStrategy";
import { checkDue, clipText, dayAfter, dismissedCheck, freshCheck, lookNow, materialReasons, nextCheck, reasonLine, reasonsKey, type LookInput } from "./checkRules";

// Made-up competitors, situations and articles. The strategy was approved on 2 Nov; today is 26 Nov.
const NOW = "2026-11-26T12:00:00.000Z";
const APPROVED = "2026-11-02T09:00:00.000Z";
const BUSY = "sit_aaaaaa01";
const RETAINER = "sit_aaaaaa02";
const QUIET = "sit_aaaaaa03";
let n = 0;
const art = (competitorId: string, over: Partial<CompetitorArticle> = {}): CompetitorArticle =>
  ({
    id: `${competitorId}_a${String(++n).padStart(3, "0")}`,
    competitorId,
    url: `https://${competitorId}.test/blog/${n}`,
    title: `Article ${n}`,
    status: "read",
    readBy: "direct",
    publishedAt: "2026-11-10",
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

const base: Omit<LookInput, "articles"> = {
  focusIds: [BUSY, RETAINER, QUIET],
  situations: [
    { id: BUSY, text: "Buyers now ask a chat assistant first.", questions: 12, answered: 3 },
    { id: RETAINER, text: "An agency packages it into a retainer", questions: 9, answered: 0 },
    { id: QUIET, text: "Nobody writes on this one", questions: 4, answered: 0 },
    { id: "sit_aaaaaa04", text: "Not a focus situation", questions: 2, answered: 0 },
  ],
  competitors: [
    { id: "cmp_rival", name: "Rivalco" },
    { id: "cmp_peer", name: "Peerly" },
  ],
  alternatives: [{ name: "Bigsuite", aliases: ["Big Suite"] }],
  nowMs: Date.parse(NOW),
};
const input = (articles: CompetitorArticle[], over: Partial<LookInput> = {}): LookInput => ({ ...base, articles, ...over });
const onBusy = (competitorId: string, count: number, over: Partial<CompetitorArticle> = {}) => Array.from({ length: count }, () => art(competitorId, { situationIds: [BUSY], ...over }));

describe("what a look sees", () => {
  it("counts their new articles on each focus situation by publish date, from the day it counts from", () => {
    const look = lookNow(
      input([
        ...onBusy("cmp_rival", 2, { publishedAt: "2026-11-02" }),
        ...onBusy("cmp_peer", 1, { publishedAt: "2026-11-20" }),
        // Published before the day it counts from: in the 90 days, but not new.
        ...onBusy("cmp_rival", 2, { publishedAt: "2026-10-15" }),
      ]),
      "2026-11-02",
    );
    const busy = look.focus.find((f) => f.id === BUSY)!;
    expect(busy).toMatchObject({ they: 5, newSince: 3, questions: 12, answered: 3 });
    expect(look.newBy.get(BUSY)).toEqual([
      { name: "Rivalco", count: 2 },
      { name: "Peerly", count: 1 },
    ]);
    expect(busy.by).toEqual([
      { name: "Rivalco", count: 4 },
      { name: "Peerly", count: 1 },
    ]);
  });

  it("counts new articles within the same 90 days as every other number", () => {
    // Read this month, published before the 90 days: neither theirs on it nor new, whatever the day it counts from.
    const look = lookNow(input(onBusy("cmp_rival", 3, { publishedAt: "2026-08-01" })), "2026-07-01");
    expect(look.focus.find((f) => f.id === BUSY)).toMatchObject({ they: 0, newSince: 0 });
  });

  it("never counts an article with no publish date as new: it might be old", () => {
    const look = lookNow(input(onBusy("cmp_rival", 4, { publishedAt: null, readAt: "2026-11-25T00:00:00.000Z" })), "2026-11-02");
    expect(look.focus.find((f) => f.id === BUSY)).toMatchObject({ they: 4, newSince: 0 });
  });

  it("looks at the focus situations only, in the strategy's order, and leaves out one no longer decided", () => {
    const look = lookNow(input([], { focusIds: [QUIET, "sit_gone0001", BUSY] }), "2026-11-02");
    expect(look.focus.map((f) => f.id)).toEqual([QUIET, BUSY]);
  });

  it("reads nothing into no articles: no focus situation is a gap, and nothing is raised", () => {
    const look = lookNow(input([]), "2026-11-02");
    expect(look.focus.map((f) => f.flag)).toEqual(["you_lead", "open", "open"]);
    expect(materialReasons(look, { gapIds: [], raisedNames: [] })).toEqual([]);
  });
});

describe("the reasons to ask for a look", () => {
  const named = (count: number) => Array.from({ length: count }, () => art("cmp_peer", { mentions: { you: [], others: ["Bigsuite"], products: [] } }));

  it("asks at 3 new articles on one focus situation, not at 2", () => {
    const two = lookNow(input(onBusy("cmp_rival", 2)), "2026-11-02");
    expect(materialReasons(two, { gapIds: [], raisedNames: [] })).toEqual([]);
    const three = lookNow(input(onBusy("cmp_rival", 3)), "2026-11-02");
    expect(materialReasons(three, { gapIds: [], raisedNames: [] })).toEqual([{ kind: "new_articles", ref: BUSY, text: "Buyers now ask a chat assistant first.", count: 3, by: [{ name: "Rivalco", count: 3 }] }]);
  });

  it("asks when a focus situation is newly a gap, never on the first look, and not again for one it knew", () => {
    const look = lookNow(input([art("cmp_rival", { situationIds: [RETAINER] })]), "2026-11-02");
    expect(look.focus.find((f) => f.id === RETAINER)!.flag).toBe("gap");
    expect(materialReasons(look, { gapIds: null, raisedNames: [] })).toEqual([]);
    expect(materialReasons(look, { gapIds: [RETAINER], raisedNames: [] })).toEqual([]);
    expect(materialReasons(look, { gapIds: [], raisedNames: [] })).toMatchObject([{ kind: "new_gap", ref: RETAINER, count: 1 }]);
  });

  it("asks once for an alternative on the map they name in 3 articles that the brand doesn't watch", () => {
    expect(materialReasons(lookNow(input(named(2)), "2026-11-02"), { gapIds: [], raisedNames: [] })).toEqual([]);
    const look = lookNow(input(named(3)), "2026-11-02");
    expect(materialReasons(look, { gapIds: [], raisedNames: [] })).toEqual([{ kind: "named", ref: "Bigsuite", text: "Bigsuite", count: 3, by: [] }]);
    expect(materialReasons(look, { gapIds: [], raisedNames: ["bigsuite"] })).toEqual([]);
  });

  it("keeps a key that changes with what the reasons are about, not with their counts", () => {
    const a = materialReasons(lookNow(input(onBusy("cmp_rival", 3)), "2026-11-02"), { gapIds: [], raisedNames: [] });
    const b = materialReasons(lookNow(input(onBusy("cmp_rival", 5)), "2026-11-02"), { gapIds: [], raisedNames: [] });
    const c = materialReasons(lookNow(input([...onBusy("cmp_rival", 3), ...named(3)]), "2026-11-02"), { gapIds: [], raisedNames: [] });
    expect(reasonsKey(a)).toBe(reasonsKey(b));
    expect(reasonsKey(a)).not.toBe(reasonsKey(c));
    expect(reasonsKey(a)).toMatch(/^chk_[a-z0-9]+$/);
  });
});

describe("the check over the weeks", () => {
  const at = (day: string) => `${day}T12:00:00.000Z`;
  const nowOf = (iso: string, articles: CompetitorArticle[]) => input(articles, { nowMs: Date.parse(iso) });

  it("counts from the day after the approval, looks again in 7 days, and a quiet look keeps the gaps it saw", () => {
    expect(dayAfter(APPROVED)).toBe("2026-11-03");
    expect(dayAfter("2026-12-31T23:59:00.000Z")).toBe("2027-01-01");
    const first = nextCheck(null, APPROVED, nowOf(NOW, [art("cmp_rival", { situationIds: [RETAINER] })]), NOW);
    expect(first).toMatchObject({ since: "2026-11-03", lookedAt: NOW, nextAt: "2026-12-03T12:00:00.000Z", open: null, gapIds: [RETAINER] });
    expect(StrategyCheckSchema.parse(first)).toEqual(first);
    expect(JSON.stringify(first).length).toBeLessThan(4096);
  });

  it("opens one row, works its reasons out again each look, and closes it when none are left", () => {
    const quiet = nextCheck(null, APPROVED, nowOf(NOW, []), NOW);
    const raised = nextCheck(quiet, APPROVED, nowOf(at("2026-12-03"), onBusy("cmp_rival", 3)), at("2026-12-03"));
    expect(raised.open).toMatchObject({ raisedAt: at("2026-12-03"), actedAt: null, reasons: [{ kind: "new_articles", count: 3 }] });
    const more = nextCheck(raised, APPROVED, nowOf(at("2026-12-10"), [...onBusy("cmp_rival", 3), ...onBusy("cmp_peer", 2)]), at("2026-12-10"));
    expect(more.open).toMatchObject({ raisedAt: at("2026-12-03"), key: raised.open!.key, reasons: [{ count: 5 }] });
    // The same articles, past the 90 days now: nothing material is left.
    const later = nextCheck(more, APPROVED, nowOf(at("2027-03-20"), [...onBusy("cmp_rival", 3), ...onBusy("cmp_peer", 2)]), at("2027-03-20"));
    expect(later).toMatchObject({ open: null, since: "2027-03-21" });
  });

  it("notes the gaps on a first look that opens a row, so a gap that comes while it is open is raised", () => {
    const first = nextCheck(null, APPROVED, nowOf(NOW, onBusy("cmp_rival", 3)), NOW);
    expect(first).toMatchObject({ gapIds: [], open: { reasons: [{ kind: "new_articles" }] } });
    const week = nextCheck(first, APPROVED, nowOf(at("2026-12-03"), [...onBusy("cmp_rival", 3), art("cmp_peer", { situationIds: [RETAINER] })]), at("2026-12-03"));
    expect(week.open?.reasons.map((r) => [r.kind, r.ref])).toEqual([
      ["new_articles", BUSY],
      ["new_gap", RETAINER],
    ]);
  });

  it("keeps a Propose on a row only while the row is about the same things", () => {
    const raised = nextCheck(null, APPROVED, nowOf(NOW, onBusy("cmp_rival", 3)), NOW);
    const acted: StrategyCheck = { ...raised, open: { ...raised.open!, actedAt: NOW } };
    expect(nextCheck(acted, APPROVED, nowOf(at("2026-12-03"), onBusy("cmp_rival", 4)), at("2026-12-03")).open?.actedAt).toBe(NOW);
    const named = Array.from({ length: 3 }, () => art("cmp_peer", { mentions: { you: [], others: ["Bigsuite"], products: [] } }));
    expect(nextCheck(acted, APPROVED, nowOf(at("2026-12-03"), [...onBusy("cmp_rival", 4), ...named]), at("2026-12-03")).open?.actedAt).toBeNull();
  });

  it("doesn't count again what was published on the day of a dismissal", () => {
    const sameDay = onBusy("cmp_rival", 3, { publishedAt: "2026-11-26" });
    const raised = nextCheck(null, "2026-11-20T09:00:00.000Z", nowOf(NOW, sameDay), NOW);
    expect(raised.open).not.toBeNull();
    const dismissed = dismissedCheck(raised, NOW);
    expect(nextCheck(dismissed, "2026-11-20T09:00:00.000Z", nowOf(at("2026-12-28"), sameDay), at("2026-12-28")).open).toBeNull();
  });

  it("keeps quiet 30 days after a dismissal, keeps its numbers current meanwhile, then counts from the dismissal's day", () => {
    const raised = nextCheck(null, APPROVED, nowOf(NOW, onBusy("cmp_rival", 3, { publishedAt: "2026-11-20" })), NOW);
    expect(raised.open).not.toBeNull();
    const dismissed = dismissedCheck(raised, NOW);
    expect(dismissed).toMatchObject({ open: null, dismissedUntil: "2026-12-26T12:00:00.000Z", since: "2026-11-27" });
    const busyWeek = [...onBusy("cmp_rival", 3, { publishedAt: "2026-11-20" }), ...onBusy("cmp_peer", 4, { publishedAt: "2026-12-01" })];
    const inQuiet = nextCheck(dismissed, APPROVED, nowOf(at("2026-12-03"), busyWeek), at("2026-12-03"));
    expect(inQuiet.open).toBeNull();
    expect(inQuiet.focus.find((f) => f.id === BUSY)).toMatchObject({ they: 7, newSince: 4 });
    expect(inQuiet.since).toBe("2026-11-27");
    const after = nextCheck(inQuiet, APPROVED, nowOf(at("2026-12-28"), busyWeek), at("2026-12-28"));
    expect(after).toMatchObject({ dismissedUntil: null, open: { reasons: [{ kind: "new_articles", count: 4, by: [{ name: "Peerly", count: 4 }] }] } });
  });

  it("approving keeps the open row's names as raised, so the same row doesn't come straight back", () => {
    const named = Array.from({ length: 3 }, () => art("cmp_peer", { mentions: { you: [], others: ["Bigsuite"], products: [] } }));
    const raised = nextCheck(null, APPROVED, nowOf(NOW, named), NOW);
    expect(raised.open?.reasons).toMatchObject([{ kind: "named", ref: "Bigsuite" }]);
    const approvedAgain = freshCheck(NOW, raised);
    expect(approvedAgain.raisedNames).toEqual(["Bigsuite"]);
    expect(nextCheck(approvedAgain, NOW, nowOf(at("2026-11-26"), named), at("2026-11-26")).open).toBeNull();
  });

  it("doesn't raise a name it raised before, after a dismissal or a new approval", () => {
    const named = Array.from({ length: 3 }, () => art("cmp_peer", { mentions: { you: [], others: ["Big Suite"], products: [] } }));
    const raised = nextCheck(null, APPROVED, nowOf(NOW, named), NOW);
    expect(raised.open?.reasons).toMatchObject([{ kind: "named", ref: "Bigsuite" }]);
    const dismissed = dismissedCheck(raised, NOW);
    expect(dismissed.raisedNames).toEqual(["Bigsuite"]);
    const approvedAgain = freshCheck("2026-12-01T10:00:00.000Z", dismissed);
    expect(approvedAgain).toMatchObject({ since: "2026-12-02", raisedNames: ["Bigsuite"], open: null, gapIds: null, nextAt: null, dismissedUntil: null });
    expect(nextCheck(approvedAgain, "2026-12-01T10:00:00.000Z", nowOf(at("2026-12-01"), named), at("2026-12-01")).open).toBeNull();
  });

  it("is due when it has never looked, or its next look has come", () => {
    expect(checkDue(null, Date.parse(NOW))).toBe(true);
    expect(checkDue({ nextAt: null }, Date.parse(NOW))).toBe(true);
    expect(checkDue({ nextAt: "2026-11-26T11:00:00.000Z" }, Date.parse(NOW))).toBe(true);
    expect(checkDue({ nextAt: "2026-11-27T11:00:00.000Z" }, Date.parse(NOW))).toBe(false);
  });
});

describe("what Review says", () => {
  const check: StrategyCheck = freshCheck(APPROVED, null);

  it("says each reason in plain words, with the day it counts from", () => {
    const one = reasonLine({ kind: "new_articles", ref: BUSY, text: "Buyers now ask a chat assistant first.", count: 4, by: [{ name: "Peerly", count: 4 }] }, check.since, NOW);
    expect(one).toBe('Peerly wrote 4 new articles on "Buyers now ask a chat assistant first" since 3 Nov.');
    const many = reasonLine({ kind: "new_articles", ref: BUSY, text: "Buyers now ask a chat assistant first", count: 5, by: [{ name: "Rivalco", count: 3 }, { name: "Peerly", count: 2 }] }, "2025-12-30", NOW);
    expect(many).toBe('Your competitors wrote 5 new articles on "Buyers now ask a chat assistant first" since 30 Dec 2025: Rivalco 3, Peerly 2.');
    const gap = reasonLine({ kind: "new_gap", ref: RETAINER, text: "An agency packages it into a retainer", count: 2, by: [] }, check.since, NOW);
    expect(gap).toBe('"An agency packages it into a retainer" is now a gap: your competitors write on it, and no live article of yours answers it yet.');
    const name = reasonLine({ kind: "named", ref: "Bigsuite", text: "Bigsuite", count: 1, by: [] }, check.since, NOW);
    expect(name).toBe("Your competitors name Bigsuite in 1 article, and you don't watch it.");
    for (const line of [one, many, gap, name]) {
      expect(dashesIn(line)).toEqual([]);
      expect(aiTellsIn(line)).toEqual([]);
    }
  });

  it("cuts long words at a word", () => {
    expect(clipText("one two three four five", 12)).toBe("one two…");
    expect(clipText("  short  ", 12)).toBe("short");
  });
});
