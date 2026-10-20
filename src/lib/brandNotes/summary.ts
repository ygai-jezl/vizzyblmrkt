import { BRAND_NOTE_KINDS, type BrandNote, type BrandNoteKind } from "@/lib/types/brandNote";

/**
 * What a brand's notes add up to: how many of each kind, and which brand map subjects they cover.
 * Open questions (status `asked`) are counted apart and in nothing else. Pure + client-safe.
 */
export interface NotesSummary {
  /** Kept and suggested notes: open questions aren't notes yet. */
  total: number;
  kept: number;
  suggested: number;
  /** Open questions: asked by an article, not answered yet. */
  asked: number;
  /** Kept notes of each kind. */
  kinds: Record<BrandNoteKind, number>;
  /** The brand map subjects at least one kept note is linked to. */
  subjectIds: string[];
}

export function summariseNotes(notes: BrandNote[]): NotesSummary {
  const kinds = Object.fromEntries(BRAND_NOTE_KINDS.map((k) => [k, 0])) as Record<BrandNoteKind, number>;
  const subjects = new Set<string>();
  let kept = 0;
  let suggested = 0;
  let asked = 0;
  for (const n of notes) {
    if (n.status === "asked") asked += 1;
    if (n.status === "suggested") suggested += 1;
    if (n.status !== "kept") continue;
    kept += 1;
    kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
    for (const id of n.subjectIds ?? []) subjects.add(id);
  }
  return { total: kept + suggested, kept, suggested, asked, kinds, subjectIds: [...subjects] };
}

