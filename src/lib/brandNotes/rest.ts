import { NOTES_REST_DEFAULTS, type BrandNote, type NoteUse, type NotesRest } from "@/lib/types/brandNote";

/**
 * Whether a note rests (BRAND_NOTES_REST_ENABLED): the match leaves a resting note out of an
 * article by itself, and a person may still add it. It rests when it is used up (written into
 * `maxUses` articles, counting the undated ones in `usedBy` from before dates were kept), when an
 * article was written with it in the last `restDays`, or when another article's draft took it in
 * that time and hasn't been written yet. The article asking never counts against itself.
 * Pure + client-safe.
 */

export type RestReason = "used_up" | "recent" | "held";

export interface NoteRestState {
  /** Articles written with it, the one asking left out. */
  written: number;
  /** The newest dated use an article was written with (the one asking left out). */
  last: NoteUse | null;
  /** Why it rests, or null when it is ready to go in. */
  reason: RestReason | null;
  /** When the rest ends (ISO), for `recent` and `held`. */
  until: string | null;
  /** The article behind the reason: the last one written with it, or the draft holding it. */
  by: NoteUse | null;
}

const DAY = 86_400_000;
const time = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/** A note's dated uses, one per article (the newest wins). */
export function usesOf(note: Pick<BrandNote, "uses">): NoteUse[] {
  const byRef = new Map<string, NoteUse>();
  for (const u of Array.isArray(note.uses) ? note.uses : []) {
    if (!u || typeof u.ref !== "string" || typeof u.at !== "string") continue;
    const had = byRef.get(u.ref);
    if (!had || time(u.at) >= time(had.at)) byRef.set(u.ref, u);
  }
  return [...byRef.values()];
}

export function noteRest(
  note: Pick<BrandNote, "uses" | "usedBy">,
  settings: Partial<NotesRest> | null | undefined,
  now: Date,
  articleRef?: string,
): NoteRestState {
  const restDays = settings?.restDays ?? NOTES_REST_DEFAULTS.restDays;
  const maxUses = settings?.maxUses ?? NOTES_REST_DEFAULTS.maxUses;
  const others = usesOf(note).filter((u) => u.ref !== articleRef);
  const written = others.filter((u) => u.written);
  const refs = new Set([...written.map((u) => u.ref), ...(Array.isArray(note.usedBy) ? note.usedBy : [])]);
  if (articleRef) refs.delete(articleRef);
  const last = written.reduce<NoteUse | null>((a, u) => (!a || time(u.at) > time(a.at) ? u : a), null);
  const base = { written: refs.size, last };

  if (refs.size >= maxUses) return { ...base, reason: "used_up", until: null, by: last };
  const ends = (u: NoteUse) => time(u.at) + restDays * DAY;
  if (last && ends(last) > now.getTime()) return { ...base, reason: "recent", until: new Date(ends(last)).toISOString(), by: last };
  const held = others
    .filter((u) => !u.written && ends(u) > now.getTime())
    .reduce<NoteUse | null>((a, u) => (!a || time(u.at) > time(a.at) ? u : a), null);
  if (held) return { ...base, reason: "held", until: new Date(ends(held)).toISOString(), by: held };
  return { ...base, reason: null, until: null, by: null };
}
