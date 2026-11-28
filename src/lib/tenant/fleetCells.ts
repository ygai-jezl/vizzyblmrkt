import { FieldValue } from "firebase-admin/firestore";
import { ISO_WEEK_RE, type CounterTree } from "@/lib/types/loopDay";
import { FLEET_CELL_PREFIX, FLEET_ROWS, type FleetCellDoc, type FleetRow } from "@/lib/types/fleetCell";
import { TenantValidationError } from "./errors";
import { getDb } from "./firestore";
import type { FirestoreLike } from "./types";

/**
 * Counts across brands (`fleet_cells`, learning loops step 5): one row per kind of choice and
 * closed week, plus the copy's own rows (src/lib/types/fleetCell.ts). They belong to the copy, not
 * to any brand, so they live in the control plane `(default)` database for every region, and hold
 * counts only: no brand or organisation ids or hashes, no people and no words.
 *
 * The lane adds a run's increments in one go at the end of the run (addToFleetCells), and the
 * Loops section and Work's Used counts read rows by id (readFleetCells). Nothing queries them, and
 * nothing a brand's agent calls reads them. Every read and write is bounded.
 */
export const FLEET_CELLS = "fleet_cells" as const;

/** Rows read at once, at most: the Loops section reads 2 closed weeks of about 100 rows each. */
export const FLEET_READ_MAX = 400;
/** Rows written at once, at most: one run's heartbeat adds to its closed weeks' rows. */
export const FLEET_WRITE_MAX = 400;
/** Counts in one row's write, at most, so a row stays far below Firestore's 1 MiB a document. */
export const FLEET_LEAVES_MAX = 5_000;
/** How deep a row's counts nest, at most. */
const DEPTH_MAX = 6;
/** Writes in flight at once. */
const IN_FLIGHT = 50;

/** A kind as the learning registry names one (a LOOPS key, or the image pool): never an id. */
const KIND_RE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)?$/;
const KIND_MAX = 64;
/** A counter's key: a stage, plan, industry, arm, reason, purpose or type, or a scope with a dot. */
const COUNTER_KEY = /^[A-Za-z0-9_.-]{1,80}$/;
const ROWS: ReadonlySet<string> = new Set(Object.values(FLEET_ROWS));

const controlDb = (db?: FirestoreLike): FirestoreLike => db ?? (getDb() as unknown as FirestoreLike);

function weekPart(isoWeek: string): string {
  if (!ISO_WEEK_RE.test(isoWeek)) throw new TenantValidationError(`fleet_cells needs an ISO week such as 2026-W48, not ${isoWeek}`);
  return isoWeek;
}

function kindPart(kind: string): string {
  if (kind.length > KIND_MAX || !KIND_RE.test(kind)) throw new TenantValidationError(`fleet_cells needs a kind such as post_image or canvas.image_style, not ${kind}`);
  return kind;
}

/** The ids of the rows: built here, never from a request. */
export const fleetCellId = {
  /** One kind of choice in a closed week. */
  kind: (kind: string, isoWeek: string) => `${FLEET_CELL_PREFIX}:${kindPart(kind)}:${weekPart(isoWeek)}`,
  /** Organisations by plan and industry, and coverage. */
  orgs: (isoWeek: string) => `${FLEET_CELL_PREFIX}:${FLEET_ROWS.orgs}:${weekPart(isoWeek)}`,
  /** Made per ontology type. */
  types: (isoWeek: string) => `${FLEET_CELL_PREFIX}:${FLEET_ROWS.types}:${weekPart(isoWeek)}`,
  /** Calls per AI purpose. */
  calls: (isoWeek: string) => `${FLEET_CELL_PREFIX}:${FLEET_ROWS.calls}:${weekPart(isoWeek)}`,
};

/** A row's id, checked to be one fleetCellId builds. */
function cellId(id: string): string {
  const [prefix, row, week, ...rest] = id.split(":");
  const known = row !== undefined && (ROWS.has(row as FleetRow) || (row.length <= KIND_MAX && KIND_RE.test(row)));
  if (prefix !== FLEET_CELL_PREFIX || !known || week === undefined || !ISO_WEEK_RE.test(week) || rest.length) {
    throw new TenantValidationError(`fleet_cells/${id} is not a row fleetCellId builds`);
  }
  return id;
}

/** Rows by id; a missing one is null. One read each, all at once, at most FLEET_READ_MAX. */
export async function readFleetCells(ids: readonly string[], db?: FirestoreLike): Promise<Array<FleetCellDoc | null>> {
  if (ids.length > FLEET_READ_MAX) throw new TenantValidationError(`fleet_cells reads at most ${FLEET_READ_MAX} rows at once`);
  const col = controlDb(db).collection(FLEET_CELLS);
  const snaps = await Promise.all(ids.map((id) => col.doc(cellId(id)).get()));
  return snaps.map((snap) => {
    if (!snap.exists) return null;
    const n = snap.data()?.n;
    return { id: snap.id, n: n && typeof n === "object" && !Array.isArray(n) ? (n as Record<string, unknown>) : {} };
  });
}

/** Add `from` into `into`, summing the amounts both hold. */
function addTree(into: CounterTree, from: CounterTree, depth = 0): void {
  if (depth >= DEPTH_MAX) throw new TenantValidationError(`fleet_cells counts nest at most ${DEPTH_MAX} deep`);
  for (const [key, value] of Object.entries(from)) {
    if (!COUNTER_KEY.test(key)) throw new TenantValidationError(`fleet_cells counter keys are letters, digits, underscores, dots and hyphens, not ${key.slice(0, 80)}`);
    const was = into[key];
    if (was !== undefined && typeof was !== typeof value) throw new TenantValidationError(`fleet_cells counter ${key} is both an amount and a map`);
    if (typeof value === "number") {
      into[key] = ((was as number | undefined) ?? 0) + value;
    } else {
      const child = (was as CounterTree | undefined) ?? {};
      addTree(child, value, depth + 1);
      into[key] = child;
    }
  }
}

/** The increments worth writing: whole amounts above 0 only, since counts across brands only grow. Null when none. */
function toIncrements(tree: CounterTree, leaves: { n: number }): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === "number") {
      if (!Number.isInteger(value) || value <= 0) continue;
      if (++leaves.n > FLEET_LEAVES_MAX) throw new TenantValidationError(`fleet_cells writes at most ${FLEET_LEAVES_MAX} counts a row`);
      out[key] = FieldValue.increment(value);
    } else {
      const child = toIncrements(value, leaves);
      if (child) out[key] = child;
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Add to rows' counts under `n`: one merged write of increments a row, never a read and never a
 * transaction, at most FLEET_WRITE_MAX rows a call. The same row named twice is added up first.
 * The heartbeat moves each organisation's mark before its increments get here, so a run cut off
 * part way undercounts and never counts twice. Answers the rows written.
 */
export async function addToFleetCells(cells: ReadonlyArray<{ id: string; n: CounterTree }>, db?: FirestoreLike): Promise<number> {
  const byId = new Map<string, CounterTree>();
  for (const cell of cells) {
    const id = cellId(cell.id);
    const tree = byId.get(id) ?? {};
    addTree(tree, cell.n);
    byId.set(id, tree);
  }
  if (byId.size > FLEET_WRITE_MAX) throw new TenantValidationError(`fleet_cells writes at most ${FLEET_WRITE_MAX} rows at once`);
  const writes = [...byId].flatMap(([id, tree]) => {
    const n = toIncrements(tree, { n: 0 });
    return n ? [{ id, n }] : [];
  });
  const col = controlDb(db).collection(FLEET_CELLS);
  for (let i = 0; i < writes.length; i += IN_FLIGHT) {
    await Promise.all(writes.slice(i, i + IN_FLIGHT).map((w) => col.doc(w.id).set({ n: w.n }, { merge: true })));
  }
  return writes.length;
}
