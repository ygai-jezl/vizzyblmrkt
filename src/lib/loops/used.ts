import { readFleetCells, fleetCellId } from "@/lib/tenant/fleetCells";
import type { FirestoreLike } from "@/lib/tenant/types";
import { ISO_WEEK_RE } from "@/lib/types/loopDay";
import { isLoopsEnabled } from "./flags";
import { kindView, namedCount, roundTwo, showsThings } from "./fleetView";
import type { LoopKind } from "./registry";
import { rowKindOf } from "./stages";

/**
 * Work's Used counts across brands (learning loops step 5, 4.10 of the plan for steps 4 and 5),
 * read from the heartbeat's closed weeks in `fleet_cells`, never by walking brands:
 *
 * - Used `{loopKind}`: the organisations whose week counted it, and the capped made counts;
 * - Used `{type}`: the same per ontology type (`fh:_types`);
 * - Used `{purpose}`: uses per AI purpose (`fh:_calls`), which replaces Work v1's walk over every
 *   brand's meter once LOOPS_ENABLED is on.
 *
 * Nothing shows below LOOP_RULES.cellOrgs organisations, and every answer carries the check text
 * (USED_NOTE). Work's measure checks call it (loopsCountForCheck in src/lib/work/counted.ts),
 * which say USED_NOTE in Work's own words (LOOPS_COUNT_NOTE in src/lib/work/words.ts). Server only.
 */

/** The most closed weeks one read covers: a quarter. */
export const USED_WEEKS_MAX = 13;

/** What Work's check says about these counts. */
export const USED_NOTE =
  "Counted; may undercount: each count is added once and never retried, a person's own uploads are left out, nothing is counted while the learning loops are off, brands that opted out are left out, a short week undercounts, and counts lag up to a week.";

export type UsedAsk = { loopKind: LoopKind } | { type: string } | { purpose: string };

export interface UsedWeek {
  week: string;
  /** Organisations counted that week. */
  orgs: number;
  /** Made (or uses, for a purpose), rounded to 2 significant figures; null below 10 organisations. */
  count: number | null;
}

export type UsedAnswer = { off: "loops_off" } | { weeks: UsedWeek[]; note: string };

/** Work's Used count for a kind, type or purpose over closed weeks, oldest first. Off with LOOPS_ENABLED off, reading nothing. */
export async function usedAcrossBrands(ask: UsedAsk, weeks: readonly string[], deps: { db?: FirestoreLike } = {}): Promise<UsedAnswer> {
  if (!isLoopsEnabled()) return { off: "loops_off" };
  const ws = [...new Set(weeks.filter((w) => ISO_WEEK_RE.test(w)))].sort().slice(-USED_WEEKS_MAX);
  let ids: string[];
  if ("loopKind" in ask) {
    const row = rowKindOf(ask.loopKind);
    if (!row) return { weeks: [], note: USED_NOTE };
    ids = ws.map((w) => fleetCellId.kind(row, w));
  } else ids = ws.map((w) => ("type" in ask ? fleetCellId.types(w) : fleetCellId.calls(w)));
  const rows = await readFleetCells(ids, deps.db);
  return {
    note: USED_NOTE,
    weeks: ws.map((week, i) => {
      const n = rows[i]?.n;
      if ("loopKind" in ask) {
        // The organisations whose week put numbers in the row, not every one seen in the 28 days.
        const orgs = kindView(n).weekOrgs;
        // Made by every arm, added up before rounding.
        const out = n && typeof n.out === "object" && n.out ? Object.values(n.out as Record<string, unknown>) : [];
        const made = out.reduce<number>((sum, signals) => {
          const m = signals && typeof signals === "object" ? (signals as Record<string, unknown>).made : 0;
          return sum + (typeof m === "number" && m > 0 ? m : 0);
        }, 0);
        return { week, orgs, count: showsThings(orgs) ? roundTwo(made) : null };
      }
      return { week, ...("type" in ask ? namedCount(n, "types", ask.type) : namedCount(n, "calls", ask.purpose)) };
    }),
  };
}
