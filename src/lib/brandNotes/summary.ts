import { BRAND_NOTE_KINDS, type BrandNote, type BrandNoteKind } from "@/lib/types/brandNote";

/** What a brand's notes add up to: how many of each kind, and which brand map subjects they cover. Pure + client-safe. */
export interface NotesSummary {
  total: number;
  kept: number;
  suggested: number;
  /** Kept notes of each kind. */
  kinds: Record<BrandNoteKind, number>;
  /** The brand map subjects at least one kept note is linked to. */
  subjectIds: string[];
}

export function summariseNotes(notes: BrandNote[]): NotesSummary {
  const kinds = Object.fromEntries(BRAND_NOTE_KINDS.map((k) => [k, 0])) as Record<BrandNoteKind, number>;
  const subjects = new Set<string>();
  let kept = 0;
  for (const n of notes) {
    if (n.status !== "kept") continue;
    kept += 1;
    kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
    for (const id of n.subjectIds ?? []) subjects.add(id);
  }
  return { total: notes.length, kept, suggested: notes.length - kept, kinds, subjectIds: [...subjects] };
}

