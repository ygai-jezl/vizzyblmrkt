import type { ContentNode } from "@/lib/types/contentPlan";
import type { ResourcePurpose } from "@/lib/plans/resources";

/**
 * The AI original of a piece of copy (CONTENT_AI_ORIGINALS_ENABLED): the exact copy a writer made,
 * kept beside the copy a person edits, with what made it, and how a person changed it before
 * approving it. One doc per piece, `ai_originals/ao_<planId>_<nodeId>`, in the brand's region. It
 * is the record the loops' edits learner reads; nothing learns from it yet.
 */

/**
 * What a writer read to make the copy. A new source the writer reads gets its name here, so the
 * record says which sources fed each draft.
 */
export const WRITER_SOURCES = [
  "brand_voice",
  "audience",
  "brand_map",
  "knowledge",
  "competitor_angles",
  "context_pack",
  "proof",
  "brief",
  "exemplars",
  "post_patterns",
  "trending",
  "edit_preferences",
  "template",
  "hub_copy",
  "review",
] as const;
export type WriterSource = (typeof WRITER_SOURCES)[number];

/** Who started the writing: a person on the canvas, the autopilot, or Vizzy in a chat. */
export type OriginalBy = "person" | "autopilot" | "vizzy";

/** What a writer hands back about how it made the copy. */
export interface MadeBy {
  purpose: ResourcePurpose<"model_tokens">;
  promptId: string;
  /** A second pass rewrote the first (the blog writer's repair pass). */
  repaired?: boolean;
  sources: WriterSource[];
}

/** The prompt and model that made the copy, as exactly as today's code can say. */
export interface OriginalStamp {
  purpose: string;
  promptId: string;
  promptVersion: number;
  /** The first 12 hex characters of a sha256 of the prompt's template: it catches an edit without a version bump. */
  templateHash: string;
  model: string;
  repaired: boolean;
}

export interface AiOriginalCopy {
  body: string;
  metaTitle?: string;
  metaDescription?: string;
  at: string;
  by: OriginalBy;
  userId: string | null;
  stamp: OriginalStamp | null;
  sources: WriterSource[];
}

/** How a person changed the AI original before approving it. */
export interface EditMeasures {
  /** Words in the AI original. */
  words: number;
  /** For each run of change, the larger of the words taken out and put in. */
  wordsChanged: number;
  /** wordsChanged over words, from 0 to 1. */
  wordsChangedShare: number;
  /** Section headings (H2) a person added or cut. */
  sectionsAdded: string[];
  sectionsCut: string[];
  /** Sections kept whose words changed. */
  sectionsChanged: number;
  figuresAdded: string[];
  figuresRemoved: string[];
  linksAdded: string[];
  linksCut: string[];
  /** Minutes from the AI original to the approval, or null when the original's time is unknown. */
  minutesToApprove: number | null;
  /** Times the piece was written again before this approval. */
  regenerations: number;
  /** Approved with no word changed. */
  approvedAsWritten: boolean;
}

export type PairTrigger = "approve" | "live";

/** One approval: the AI original, the copy a person approved, and how they differ. */
export interface AiEditPair {
  original: AiOriginalCopy;
  final: { body: string; at: string; userId: string | null };
  trigger: PairTrigger;
  measures: EditMeasures;
}

/** At most this many approvals are kept per piece, newest first. */
export const PAIRS_KEPT = 3;

export interface AiOriginalDoc {
  id: string;
  tenantId: string;
  planId: string;
  workspaceId: string;
  nodeId: string;
  nodeType: ContentNode["type"];
  channel: string;
  original: AiOriginalCopy;
  /** Times the piece was written again since its first AI original. */
  regenerations: number;
  pairs: AiEditPair[];
  updatedAt: string;
}

export const aiOriginalId = (planId: string, nodeId: string) => `ao_${planId}_${nodeId}`;
