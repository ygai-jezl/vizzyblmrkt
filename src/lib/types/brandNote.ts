import { z } from "zod";

/**
 * What we've seen (BRAND_NOTES_ENABLED): one of the brand's own first-hand notes, written by its
 * team. Blog articles take experience from these and nowhere else. One document per note in
 * `brand_notes` (regional, beside the content it informs).
 */

export const BRAND_NOTE_KINDS = ["customer_story", "tested", "mistake", "objection", "numbers", "before_after", "disagree"] as const;
export const BrandNoteKind = z.enum(BRAND_NOTE_KINDS);
export type BrandNoteKind = z.infer<typeof BrandNoteKind>;

/** How each kind is named on the page, singular and as a group. */
export const BRAND_NOTE_KIND_LABEL: Record<BrandNoteKind, { one: string; many: string }> = {
  customer_story: { one: "Customer story", many: "Customer stories" },
  tested: { one: "Something we tested", many: "Things we tested" },
  mistake: { one: "A mistake we see", many: "Mistakes we see" },
  objection: { one: "An objection we hear", many: "Objections we hear" },
  numbers: { one: "Our own numbers", many: "Our own numbers" },
  before_after: { one: "Before and after", many: "Before and after" },
  disagree: { one: "Where we disagree", many: "Where we disagree" },
};

/** Where a note came from: typed on the page, pulled out of a pasted call, written for an article, or suggested by Vizzy. */
export const BrandNoteSource = z.enum(["typed", "paste", "article", "chat"]);
export type BrandNoteSource = z.infer<typeof BrandNoteSource>;

/** `suggested`: Vizzy proposed it and nobody has kept it yet; articles use only `kept` notes. */
export const BrandNoteStatus = z.enum(["kept", "suggested"]);
export type BrandNoteStatus = z.infer<typeof BrandNoteStatus>;

export const BRAND_NOTE_LIMITS = {
  /** A runaway backstop per brand, not an expected size. */
  MAX_NOTES: 2000,
  MIN_TEXT: 12,
  MAX_TEXT: 1200,
  MAX_SUBJECTS: 8,
  MAX_USED_BY: 50,
} as const;

/** What a person (or Vizzy) gives for a note. */
export const BrandNoteInputSchema = z.object({
  text: z.string().trim().min(BRAND_NOTE_LIMITS.MIN_TEXT).max(BRAND_NOTE_LIMITS.MAX_TEXT),
  kind: BrandNoteKind,
  subjectIds: z.array(z.string().min(1).max(64)).max(BRAND_NOTE_LIMITS.MAX_SUBJECTS).default([]),
  canName: z.boolean().default(false),
});
export type BrandNoteInput = z.infer<typeof BrandNoteInputSchema>;

export const BrandNotePatchSchema = BrandNoteInputSchema.partial().extend({ status: z.literal("kept").optional() });
export type BrandNotePatch = z.infer<typeof BrandNotePatchSchema>;

export interface BrandNote {
  id: string;
  tenantId: string;
  text: string;
  kind: BrandNoteKind;
  /** Brand map subjects the note is about. */
  subjectIds: string[];
  /** It names a customer or person who agreed to be named; otherwise articles keep them anonymous. */
  canName: boolean;
  source: BrandNoteSource;
  /** The article it was written for (`<workspaceId>/<planId>`), when it came from one. */
  sourceRef: string | null;
  status: BrandNoteStatus;
  /** The articles that used it (`<workspaceId>/<planId>`), newest last, capped. */
  usedBy: string[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}
