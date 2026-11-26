import { z } from "zod";
import { LearnedPatternRuleSchema } from "./tenant";

/**
 * One immutable snapshot of a channel's learned-pattern directive — the audit trail behind the
 * "Content Steering" panel. Every auto-promotion and every revert writes a row, each carrying the
 * transparent LLM-judge rationale ("why the AI is steering your {channel} content this way") and
 * the evidence (which promoted clusters, their support + lift) so an operator can see the reason
 * and course-correct back to any prior version. Lives in `learned_pattern_versions` (regional DB).
 */
export const PatternEvidenceSchema = z.object({
  clusterId: z.string().max(200),
  support: z.number().int().nonnegative(),
  meanLift: z.number(),
  samplePostIds: z.array(z.string().max(200)).max(5).default([]),
});

/**
 * Who set the look or rules a learning loop's version holds (learning loops step 4): a person,
 * the loop's learner, the copy carried over from before versions (seeded), or a default learned
 * across brands (fleet, from step 9).
 */
export const VERSION_SET_BY = ["person", "learned", "seeded", "fleet"] as const;
export type VersionSetBy = (typeof VERSION_SET_BY)[number];

/** How far an item's words can be trusted: a person's own action, or the brand's own content. */
export const ITEM_TRUST = ["person", "own_content"] as const;

/** Where an item came from: votes (and uploads), edits, words a person typed, the seed, or all brands. */
export const ITEM_FROM = ["votes", "edits", "person", "seed", "fleet"] as const;

/** The one change a version makes to its items. */
export const ITEM_CHANGES = ["add", "edit", "replace", "retire", "revert"] as const;

/** The most characters an item's words may hold (LOOP_RULES.lookChars). */
export const ITEM_TEXT_CHARS = 2000;

/**
 * One learned item: a rule (an image style's look is one) or an example. It holds its words, or a
 * reference to them, or neither once Forget removed them from an older row.
 */
export const LearnedItemSchema = z.object({
  id: z.string().min(1).max(16),
  type: z.enum(["rule", "example"]),
  text: z.string().max(ITEM_TEXT_CHARS).nullable().optional(),
  ref: z.string().max(200).nullable().optional(),
  trust: z.enum(ITEM_TRUST),
  from: z.enum(ITEM_FROM),
});

/** The most images that can feed one look: the top 20 liked and 8 disliked. */
export const EVIDENCE_IDS_MAX = 28;

export const LearnedPatternVersionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  channel: z.string().max(40),
  version: z.number().int().nonnegative(),
  directive: z.string().max(1500).nullable().optional(),
  perform: z.array(LearnedPatternRuleSchema).max(8).default([]),
  avoid: z.array(LearnedPatternRuleSchema).max(6).default([]),
  /** Human-readable explanation of what changed and why (the transparency deliverable). */
  judgeRationale: z.string().max(2000).default(""),
  evidence: z.array(PatternEvidenceSchema).max(12).default([]),
  championScore: z.number().nullable().optional(),
  /** auto and revert are Steering's; person, undo, forget and seed are a learning loop's (step 4). */
  createdBy: z.enum(["auto", "revert", "person", "undo", "forget", "seed"]).default("auto"),
  createdAt: z.string(),

  // ---- A learning loop's version (step 4); all optional, so Steering's rows parse as before ----
  /** The loop it belongs to, such as image_style, whose channel is `image_style.<styleId>`. */
  loop: z.string().max(40).optional(),
  setBy: z.enum(VERSION_SET_BY).optional(),
  /** What the version holds, one item per version for an image style's look. */
  items: z.array(LearnedItemSchema).max(8).optional(),
  /** The one change from the version before. */
  change: z.object({ op: z.enum(ITEM_CHANGES), itemId: z.string().min(1).max(16) }).optional(),
  /** Every image that fed the prompt. */
  evidenceIds: z.array(z.string().max(128)).max(EVIDENCE_IDS_MAX).optional(),
  /**
   * Where a learned look came from, worked out by the one writer from the evidence rows it read,
   * never given by a learner: how many of the images liked and disliked, the newest vote, and the
   * thumbs down reasons by key, for "From 3 images you liked and 2 you didn't (Wrong mood or style
   * 2), newest 14 Jan". Counts and keys only: no note and no person.
   */
  evidenceCounts: z
    .object({
      liked: z.number().int().min(0).max(EVIDENCE_IDS_MAX),
      disliked: z.number().int().min(0).max(EVIDENCE_IDS_MAX),
      newestAt: z.string().max(40).nullable(),
      downReasons: z.record(z.string().max(40), z.number().int().min(0).max(EVIDENCE_IDS_MAX)).optional(),
    })
    .optional(),
  /** Images left out of later looks: an Undo's trigger likes, or a Forget's whole evidence. */
  excludedEvidence: z.array(z.string().max(128)).max(EVIDENCE_IDS_MAX).optional(),
  /** A Forget's hash of the words it removed, so the same look is never learned again. */
  forgotHash: z.string().max(64).optional(),
  /** The member who wrote the row, on rows a person wrote (Edit the words, Undo, Forget, Go back). */
  by: z.string().max(128).optional(),
});
export type PatternEvidence = z.infer<typeof PatternEvidenceSchema>;
export type LearnedItem = z.infer<typeof LearnedItemSchema>;
export type LearnedPatternVersion = z.infer<typeof LearnedPatternVersionSchema>;

export function patternVersionDocId(tenantId: string, channel: string, version: number): string {
  return `lpv:${encodeURIComponent(tenantId)}:${channel}:${version}`;
}
