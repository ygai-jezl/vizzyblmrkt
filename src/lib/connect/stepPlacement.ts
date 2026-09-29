import type { ConnectionCatalog } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";

/**
 * Where the product actually sends each onboarding step — on the person, or on
 * one of their entities (a brand, a workspace…) — against where the catalog
 * counts it. A step the catalog keeps per person but the product only ever sends
 * per brand (or the other way round) never counts: progress reads 0 and nobody
 * is activated. This finds those, from the users the product has sent, so the
 * Catalog tab can offer the fix.
 */

/** Where a step is done: `null` = on the person, else the entity kind. */
export type Placement = string | null;

export interface StepMove {
  /** Where the catalog counts them now. */
  from: Placement;
  /** Where the product sends them. */
  to: Placement;
  stepIds: string[];
  /** Users seen sending them there. */
  users: number;
  /** `to` is a kind the catalog doesn't name yet, so it has to be added first. */
  unknownKind: boolean;
}

export interface StepPlacementReport {
  /** Users read. */
  scanned: number;
  moves: StepMove[];
  /** Step ids sent that aren't in the catalog, with where they were sent. */
  unknown: Array<{ id: string; placement: Placement; users: number }>;
}

type Users = Array<Pick<ProductUser, "steps" | "entities" | "status">>;

export function stepPlacement(users: Users, catalog: Pick<ConnectionCatalog, "onboardingSteps"> & Partial<Pick<ConnectionCatalog, "entityKinds">>): StepPlacementReport {
  /** step id → placement → users seen. */
  const seen = new Map<string, Map<Placement, number>>();
  let scanned = 0;
  for (const u of users) {
    if (u.status === "deleted") continue;
    scanned += 1;
    const mine = new Set<string>();
    for (const id of Object.keys(u.steps ?? {})) mine.add(key(id, null));
    for (const e of Object.values(u.entities ?? {})) for (const id of Object.keys(e.steps)) mine.add(key(id, e.kind));
    for (const k of mine) {
      const [id, placement] = unkey(k);
      const at = seen.get(id) ?? new Map<Placement, number>();
      at.set(placement, (at.get(placement) ?? 0) + 1);
      seen.set(id, at);
    }
  }

  const kinds = new Set((catalog.entityKinds ?? []).map((k) => k.kind));
  const moves = new Map<string, StepMove>();
  for (const s of catalog.onboardingSteps) {
    const at = seen.get(s.id);
    const from = s.kind ?? null;
    if (!at || at.has(from)) continue; // never sent, or sent where the catalog counts it
    const [to, n] = [...at.entries()].sort((a, b) => b[1] - a[1])[0]!;
    const k = key(from ?? "", to);
    const m = moves.get(k) ?? { from, to, stepIds: [], users: 0, unknownKind: to !== null && !kinds.has(to) };
    m.stepIds.push(s.id);
    m.users = Math.max(m.users, n);
    moves.set(k, m);
  }
  const known = new Set(catalog.onboardingSteps.map((s) => s.id));
  const unknown = [...seen.entries()]
    .filter(([id]) => !known.has(id))
    .flatMap(([id, at]) => [...at.entries()].map(([placement, users]) => ({ id, placement, users })))
    .sort((a, b) => b.users - a.users || a.id.localeCompare(b.id));
  return { scanned, moves: [...moves.values()], unknown };
}

/** Apply a move to the catalog's steps: those steps are then counted where the product sends them. */
export function applyStepMove<S extends { id: string; kind?: string | null }>(steps: S[], move: Pick<StepMove, "to" | "stepIds">): S[] {
  const ids = new Set(move.stepIds);
  return steps.map((s) => (ids.has(s.id) ? { ...s, kind: move.to } : s));
}

const key = (id: string, placement: Placement) => `${id}\u0000${placement ?? ""}`;
function unkey(k: string): [string, Placement] {
  const [id, placement] = k.split("\u0000") as [string, string];
  return [id, placement || null];
}
