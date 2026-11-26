import type { HistoryEntry } from "@/lib/settings/sources";
import { erasableFrom, erasedSinceArchive, fieldErasable } from "@/lib/settings/eraseDates";
import type { RecordField, RecordFieldObject } from "@/lib/types/recordField";
import { ago } from "../people/format";
import { dayText, ERASE_COPY } from "./historyWords";

/**
 * What Data model and Settings › History say about an archived field's erase (ADR-0021). Pure, so
 * the screens and their tests read the same words. Everyone who sees an archived field is told
 * when its values are being erased or were erased (why Bring back is gone, and why it would come
 * back empty); only an owner who can erase is told when it was archived and from when its values
 * can be erased, and sees Erase values.
 */

type Dates = Pick<RecordField, "archivedAt" | "erasedAt" | "erasingSince">;

/** An archived field's erase, for anyone: "values being erased", "values erased on 3 Dec", or null. */
export function eraseState(f: Dates): string | null {
  if (f.erasingSince) return ERASE_COPY.erasing;
  if (erasedSinceArchive(f)) return ERASE_COPY.erased(dayText(f.erasedAt!));
  return null;
}

/**
 * Data model's note beside an archived field: its erase for anyone, and for an owner who can erase
 * also when it was archived and, before its 30 days are up, when its values can be erased.
 */
export function archivedFieldNote(f: Dates, owner: boolean, nowMs = Date.now()): string | null {
  if (!f.archivedAt) return null;
  const state = eraseState(f);
  if (!owner) return state;
  const archived = `archived ${ago(f.archivedAt, nowMs)}`;
  if (state) return `${archived}, ${state}`;
  const from = erasableFrom(f.archivedAt);
  return Date.parse(from) > nowMs ? `${archived}, ${ERASE_COPY.erasableFrom(dayText(from))}` : archived;
}

/** Whether an owner who can erase is offered Erase values on the field now (or to carry an erase on). */
export function offersErase(f: Dates, nowMs = Date.now()): boolean {
  return !!f.archivedAt && (!!f.erasingSince || fieldErasable(f, nowMs).ok);
}

export interface EraseTarget {
  object: RecordFieldObject;
  fieldId: string;
  label: string;
}

const OBJECT_OF: Record<string, RecordFieldObject> = { "fields:person": "person", "fields:company": "company" };

/** History's key for an entry. */
export const entryKey = (e: Pick<HistoryEntry, "subject" | "rev">) => `${e.subject}:${e.rev}`;

/**
 * Settings › History's Erase values, for an owner who can erase: on each field list entry, the
 * fields it archived that can be erased now, by entry key. A field is offered once, on the newest
 * entry listed that archived it.
 */
export function historyEraseTargets(
  entries: ReadonlyArray<Pick<HistoryEntry, "kind" | "subject" | "rev" | "archivedKeys">>,
  lists: Partial<Record<RecordFieldObject, { items: readonly RecordField[] }>>,
  nowMs = Date.now(),
): Map<string, EraseTarget[]> {
  const out = new Map<string, EraseTarget[]>();
  const seen = new Set<string>();
  for (const e of entries) {
    const object = e.kind === "fields" ? OBJECT_OF[e.subject] : undefined;
    if (!object) continue;
    for (const fieldId of e.archivedKeys) {
      if (seen.has(`${object}:${fieldId}`)) continue;
      seen.add(`${object}:${fieldId}`);
      const f = lists[object]?.items.find((x) => x.key === fieldId);
      if (!f || !offersErase(f, nowMs)) continue;
      out.set(entryKey(e), [...(out.get(entryKey(e)) ?? []), { object, fieldId, label: f.label }]);
    }
  }
  return out;
}
