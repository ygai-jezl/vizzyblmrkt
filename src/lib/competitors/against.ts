import type { CoverageFlag } from "./coverage";

/**
 * One of the brand's buying situations set against what its watched competitors wrote on it in
 * the last 90 days (STRATEGY_COMPETITORS_ENABLED), and which of them the Against your competitors
 * card shows. Pure and client safe: the Strategy tab picks the focus rows itself, from the draft it
 * has open, so a star changed there never reads the articles again.
 */

export interface SituationAgainst {
  id: string;
  text: string;
  /** Competitor articles on it in the window, and by whom (most first). */
  they: number;
  byCompetitor: Array<{ id: string; name: string; count: number }>;
  questions: number;
  answered: number;
  flag: CoverageFlag;
  /** Their articles on it since `since` (approval), or null when nothing is approved. */
  newSince: number | null;
}

/** The focus situations to set against them: the approved ones, else the draft's, else the 5 they write on most. Pure. */
export function focusAgainst(rows: SituationAgainst[], focus: { approved: string[]; draft: string[] }): { from: "approved" | "draft" | "busiest"; rows: SituationAgainst[] } {
  const pick = (ids: string[]) => ids.flatMap((id) => rows.filter((r) => r.id === id));
  if (focus.approved.length && pick(focus.approved).length) return { from: "approved", rows: pick(focus.approved) };
  if (focus.draft.length && pick(focus.draft).length) return { from: "draft", rows: pick(focus.draft) };
  return { from: "busiest", rows: rows.filter((r) => r.they > 0).sort((a, b) => b.they - a.they || a.text.localeCompare(b.text)).slice(0, 5) };
}

/**
 * The You cell of a row. A situation with no questions on the map yet says so: there is nothing to
 * answer until Find what they ask brings its questions, and Next up only picks from questions.
 */
export function answeredText(r: Pick<SituationAgainst, "questions" | "answered">): string {
  return r.questions > 0 ? `You: ${r.answered} of ${r.questions} answered` : "You: no questions yet";
}
