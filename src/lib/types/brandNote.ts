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

/**
 * Where a note came from: typed on the page, pulled out of a pasted call, written for an article,
 * suggested by Vizzy, or a question an article asked its team (BRAND_NOTES_QUESTIONS_ENABLED).
 */
export const BrandNoteSource = z.enum(["typed", "paste", "article", "chat", "question"]);
export type BrandNoteSource = z.infer<typeof BrandNoteSource>;

/**
 * `suggested`: Vizzy proposed it and nobody has kept it yet. `asked`: a question an article asked
 * its team that nobody has answered yet (its text is empty). Articles use only `kept` notes.
 */
export const BrandNoteStatus = z.enum(["kept", "suggested", "asked"]);
export type BrandNoteStatus = z.infer<typeof BrandNoteStatus>;

export const BRAND_NOTE_LIMITS = {
  /** A runaway backstop per brand, not an expected size. */
  MAX_NOTES: 2000,
  MIN_TEXT: 12,
  MAX_TEXT: 1200,
  MAX_SUBJECTS: 8,
  MAX_USED_BY: 50,
  /** Dated uses kept per note (BRAND_NOTES_REST_ENABLED), newest last. */
  MAX_USES: 50,
  MAX_QUESTION: 300,
  /** The articles an open question was asked for. */
  MAX_ASKED_FOR: 20,
  MAX_ARTICLE_TITLE: 200,
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

/**
 * How often a note goes into articles by itself (BRAND_NOTES_REST_ENABLED), set per brand: it rests
 * for `restDays` after an article uses it, and after `maxUses` articles it goes in only when a
 * person adds it.
 */
export const NOTES_REST_DEFAULTS = { restDays: 30, maxUses: 3 } as const;
export const NotesRestSchema = z.object({
  restDays: z.number().int().min(0).max(365).default(NOTES_REST_DEFAULTS.restDays),
  maxUses: z.number().int().min(1).max(50).default(NOTES_REST_DEFAULTS.maxUses),
});
export type NotesRest = z.infer<typeof NotesRestSchema>;

/**
 * One article's use of a note (BRAND_NOTES_REST_ENABLED), one per article. A draft that holds it
 * (`written` false, `at` when its draft last took it), or the article written and checked with it
 * (`written` true, `at` when it was first written).
 */
export interface NoteUse {
  ref: string;
  title: string;
  at: string;
  written: boolean;
}

/** An article a note is linked to: `<workspaceId>/<planId>`, and what it was called. */
export interface NoteArticle {
  ref: string;
  title: string;
}

/** A question with no answer yet: listed apart, used by no article. */
export const isOpenQuestion = (n: Pick<BrandNote, "status">): boolean => n.status === "asked";

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
  /** The same with dates, and the drafts holding it (BRAND_NOTES_REST_ENABLED), newest last, capped. */
  uses?: NoteUse[];
  /** The question it answers, when an article asked its team (source `question`). */
  question?: string | null;
  /** The articles that asked that question, oldest first, capped; the title is as it was then. */
  askedFor?: NoteArticle[];
  /** Who last answered the question, and when. */
  answeredBy?: string | null;
  answeredAt?: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}
