import { fieldChangedEvent } from "@/lib/ontology/eventBuilders";
import { SYSTEM_FIELD_PREFIX, systemFieldId } from "@/lib/ontology/events";
import type { ContactPersonId } from "@/lib/ontology/person";
import type { EventWrite } from "@/lib/types/ontologyEvent";

/**
 * A person's moves (AUDIENCE_TIMELINE_ENABLED): what a sync's tag changes mean, as system field
 * changes for their timeline. The sync already works out which tags it added and removed; this
 * turns them into moves using an explicit list of tag kinds, and each move into one
 * record.field_changed row on a `sys.` field id. Pure.
 *
 * Recorded:
 * - `launch:<campaignId>` (not `launch:any`): joined or left a launch, `sys.launch.<campaignId>`;
 * - `product:<connectionId>` (not `product:any`): started or stopped being a product's user,
 *   `sys.product.<connectionId>`;
 * - `stage:<connectionId>:<stage>`: a stage in a product, `sys.stage.<connectionId>`. A stage
 *   removed and another added for the same product is one move, from one to the other;
 * - `quiet:<connectionId>`: went quiet in a product or came back, `sys.quiet.<connectionId>`.
 *
 * Ignored: `all`, `launch:any`, `product:any`, `via:*`, `group:*`, `field:*` (the field writer
 * records those itself), `added:hand` (record.created says it), `launches:many`, and any prefix
 * this file doesn't know.
 */

export type MoveKind = "launch" | "product" | "stage" | "quiet";

export interface PersonMove {
  kind: MoveKind;
  /** The launch's campaign id or the product's connection id. */
  on: string;
  /** `sys.<kind>.<on>`. */
  fieldId: string;
  /** What makes the row's key: the tag, or `stage:<connectionId>` for a stage. */
  keyTag: string;
  /** A stage, or whether they were in it (launch, product, quiet). */
  before: string | boolean | null;
  after: string | boolean | null;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const STAGES = new Set(["new", "onboarding", "stuck", "activated", "member"]);

/** A tag the moves know, as its kind, what it is on and (for a stage) the stage; null for anything else. */
function parse(tag: string): { kind: MoveKind; on: string; stage?: string } | null {
  const parts = tag.split(":");
  const [prefix, on, stage, ...rest] = parts;
  if (!on || !ID.test(on) || rest.length) return null;
  switch (prefix) {
    case "launch":
    case "product":
      return on === "any" || stage !== undefined ? null : { kind: prefix, on };
    case "quiet":
      return stage !== undefined ? null : { kind: "quiet", on };
    case "stage":
      return stage && STAGES.has(stage) ? { kind: "stage", on, stage } : null;
    default:
      return null;
  }
}

function fieldIdOf(kind: MoveKind, on: string): string | null {
  try {
    return systemFieldId(kind, on);
  } catch {
    return null;
  }
}

/** A sync's tag changes as moves, in a stable order: launches, products, stages, quiet. */
export function movesOf(result: { added: readonly string[]; removed: readonly string[] }): PersonMove[] {
  const out: PersonMove[] = [];
  const stages = new Map<string, { before: string | null; after: string | null }>();
  const seen = new Set<string>();
  for (const [tags, isAdded] of [
    [result.removed, false],
    [result.added, true],
  ] as const) {
    for (const tag of tags) {
      const t = parse(tag);
      if (!t) continue;
      if (t.kind === "stage") {
        const s = stages.get(t.on) ?? { before: null, after: null };
        if (isAdded) s.after = t.stage!;
        else s.before = t.stage!;
        stages.set(t.on, s);
        continue;
      }
      const fieldId = fieldIdOf(t.kind, t.on);
      if (!fieldId || seen.has(tag)) continue;
      seen.add(tag);
      out.push({ kind: t.kind, on: t.on, fieldId, keyTag: tag, before: !isAdded, after: isAdded });
    }
  }
  for (const [on, s] of stages) {
    const fieldId = fieldIdOf("stage", on);
    if (!fieldId || s.before === s.after) continue;
    out.push({ kind: "stage", on, fieldId, keyTag: `stage:${on}`, before: s.before, after: s.after });
  }
  const rank: Record<MoveKind, number> = { launch: 0, product: 1, stage: 2, quiet: 3 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || a.on.localeCompare(b.on));
}

/** A system field id's kind and what it is on, or null for anything else (a brand's own field). */
export function parseMoveFieldId(fieldId: string): { kind: MoveKind; on: string } | null {
  if (typeof fieldId !== "string" || !fieldId.startsWith(SYSTEM_FIELD_PREFIX)) return null;
  const [kind, on, ...rest] = fieldId.slice(SYSTEM_FIELD_PREFIX.length).split(".");
  if (rest.length || !on || !ID.test(on)) return null;
  return kind === "launch" || kind === "product" || kind === "stage" || kind === "quiet" ? { kind, on } : null;
}

/** The deterministic key of one move's row: a retried sync writes nothing twice. */
export function moveKey(personId: string, changedAt: string, keyTag: string): string {
  return `move|${personId}|${changedAt}|${keyTag}`;
}

/**
 * One row per move, at the sync's changedAt, made by the system. A product's moves carry the
 * product user they are about, when there is one (so erasing or moving that product user takes
 * them along); a launch's carry none.
 */
export function moveEvents(
  personId: ContactPersonId,
  changedAt: string,
  moves: readonly PersonMove[],
  productUsers: ReadonlyMap<string, string> = new Map(),
): EventWrite[] {
  return moves.map((m) =>
    fieldChangedEvent({
      key: moveKey(personId, changedAt, m.keyTag),
      subject: { type: "person", id: personId },
      personId,
      fieldId: m.fieldId,
      object: "person",
      before: m.before,
      after: m.after,
      source: "sync",
      actor: { type: "system", id: null },
      at: changedAt,
      productUserId: m.kind === "launch" ? null : (productUsers.get(m.on) ?? null),
    }),
  );
}
