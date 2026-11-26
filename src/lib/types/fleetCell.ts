/**
 * Counts across brands (`fleet_cells`, control plane, learning loops step 5,
 * src/lib/tenant/fleetCells.ts), for the people who run the copy. One document per row and closed
 * ISO week, with every count under the one map `n`, so one field exemption covers it. Counts only:
 * no brand or organisation ids or hashes, no people and no words. Brands that opted out send
 * nothing, and an organisation counts once in a cell however many of its brands are there
 * (through its mark on `loop_lane`).
 *
 * - `fh:<kind>:<isoWeek>`: one kind of choice (the five image kinds count once, as one pool):
 *   organisations per stage and stuck, by plan and industry, refusals, cards, declines, made and
 *   voted by arm (capped per organisation), unstamped saves and coverage.
 * - `fh:_orgs:<isoWeek>`: organisations by plan and industry, brands visited against listed, late
 *   reports, the oldest week not yet folded, and brands still holding a look on the brand record.
 * - `fh:_types:<isoWeek>`: made per ontology type, with organisations.
 * - `fh:_calls:<isoWeek>`: calls per AI purpose, with organisations.
 *
 * Pure: shapes only.
 */

export const FLEET_CELL_PREFIX = "fh" as const;

/** The copy's own rows beside the kinds; a leading underscore, which no kind has, keeps them apart. */
export const FLEET_ROWS = { orgs: "_orgs", types: "_types", calls: "_calls" } as const;
export type FleetRow = (typeof FLEET_ROWS)[keyof typeof FLEET_ROWS];

/** One row as stored: its counts under `n`, as nested maps whose leaves are amounts. */
export interface FleetCellDoc {
  id: string;
  n: Record<string, unknown>;
}
