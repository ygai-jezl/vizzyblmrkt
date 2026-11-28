import { z } from "zod";
import { IMAGE_VOTE_REASON_KEYS, VOTE_NOTE_CHARS } from "@/lib/loops/reasons";
import { MadeSchema } from "./loopStamp";
import { StyleProfileSchema } from "./styleProfile";

/**
 * A single AI-generated image in the Brand Kit asset library. Unlike the scattered
 * `imageAssetRef` fields on content nodes / ebooks / email layouts, this is a central,
 * tenant-wide REGISTRY row that lets the Brand Kit gallery browse, search, and iterate
 * on every image the brand has produced. Stored in the tenant's REGIONAL DB at the
 * top-level `image_assets/{id}` collection.
 *
 * The image BYTES themselves live in the private GCS bucket (via storeWorkspaceImage,
 * key `workspace/{tenantId}/{workspaceId}/{filename}`); this doc only holds the
 * `workspaceId` + bare `filename` needed to serve them through the authenticated
 * workspace-asset proxy. The served URL is DERIVED, never stored:
 *   `/api/admin/workspace/${workspaceId}/asset/${filename}`
 */
export const ImageAssetKind = z.enum(["social", "ebook", "customized", "upload", "blog_hero"]);
export type ImageAssetKind = z.infer<typeof ImageAssetKind>;

/** Where the asset came from (best-effort linkage back to the content that produced it). */
export const ImageAssetSourceSchema = z.object({
  planId: z.string().max(128).nullable().optional(),
  nodeId: z.string().max(128).nullable().optional(),
  chapterId: z.string().max(128).nullable().optional(),
});
export type ImageAssetSource = z.infer<typeof ImageAssetSourceSchema>;

export const ImageAssetSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** The workspace the bytes are stored under (GCS key + auth-proxy path partition). */
  workspaceId: z.string(),
  /** Bare workspace-asset filename (`<uuid>.<ext>`); the full key is reconstructed server-side. */
  filename: z.string().max(300),
  mimeType: z.string().max(60),
  kind: ImageAssetKind,
  /** The expanded image prompt actually rendered (capped 1000, matches the node schema). */
  prompt: z.string().max(1000).nullable().optional(),
  /** The operator's brief / customise instruction (raw input). */
  brief: z.string().max(1000).nullable().optional(),
  /** Operator-facing aspect string ("1:1" | "4:5" | "1.91:1" | "1:4" ...). */
  aspect: z.string().max(16).nullable().optional(),
  /** Style preset id (social/ebook style id). */
  style: z.string().max(60).nullable().optional(),
  /** Destination channel for social images ("linkedin" | "x" | "instagram"). */
  channel: z.string().max(40).nullable().optional(),
  source: ImageAssetSourceSchema.nullable().optional(),
  /** Lineage: the ImageAsset this was derived from (Customise). null for originals. */
  parentAssetId: z.string().nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  byteSize: z.number().int().nonnegative().nullable().optional(),
  createdAt: z.string(),

  // ---- Brand-style feedback loop (all optional so pre-existing docs still parse) ----
  /**
   * Operator's brand-fit verdict. "up" = an on-brand exemplar the style engine learns
   * FROM (weighted by `brandRating`); "down" = an off-brand image to steer AWAY from.
   * null / absent = no verdict yet.
   */
  brandVote: z.enum(["up", "down"]).nullable().optional(),
  /**
   * On a 👍, how on-brand (1 = On Brand · 5 = Good · 10 = Perfect). Weights how much
   * this exemplar influences the synthesized style + reference-image selection. Only
   * meaningful when `brandVote === "up"`.
   */
  brandRating: z.number().int().min(1).max(10).nullable().optional(),
  /** ISO of the last vote (set/cleared alongside `brandVote`). */
  brandVoteSetAt: z.string().nullable().optional(),
  /** L1: the aesthetic fingerprint extracted from this image's bytes (👍 images only). */
  styleProfile: StyleProfileSchema.nullable().optional(),

  // ---- Learning loops, step 4 (IMAGE_STYLE_VERSIONS_ENABLED); all optional, as above ----
  /** Its stamp: the kind, scope, learned version and arm that made it, or why it has none. */
  made: MadeSchema.nullable().optional(),
  /** When a person made a new image in the same place within 14 days (LOOP_RULES.outcomeDays). */
  remadeAt: z.string().nullable().optional(),
  /** The id of the image made in its place. Never a member id. */
  remadeBy: z.string().max(128).nullable().optional(),
  /**
   * A held back image's one free remake, reserved by the request making it (src/lib/loops/remake.ts),
   * so two at once can't both be off the allowance. It lapses after a few minutes, as when that
   * image failed, and goes once the image is marked remade.
   */
  remakeClaimAt: z.string().nullable().optional(),
  /** How the brand's verdict was given: a thumbs vote, or an upload, which counts as liked. */
  brandVoteVia: z.enum(["vote", "upload"]).nullable().optional(),
  /** ISO of the first vote, set once and never reset, so re-rating an old like can't count as a new one. */
  firstVotedAt: z.string().nullable().optional(),
  /**
   * The vote as it stood LOOP_RULES.outcomeDays after the image was made: written with each vote in
   * that time and never after, so a later change can't move the image's outcome in a check (null
   * when the vote was cleared in that time). Rows without it read `brandVote`.
   */
  outcomeVote: z.enum(["up", "down"]).nullable().optional(),
  /** The reason given with the vote, one key from VOTE_REASONS.image for its direction (src/lib/loops/reasons.ts). */
  brandVoteReason: z.enum(IMAGE_VOTE_REASON_KEYS).nullable().optional(),
  /** The team's optional note with the reason: plain text, never rendered as HTML, with no writer kept. */
  brandVoteNote: z.string().max(VOTE_NOTE_CHARS).nullable().optional(),
  /** ISO of when the reason or note was given; a changed vote clears all three. */
  brandVoteReasonAt: z.string().nullable().optional(),
  /**
   * How many times reading its style profile failed in the loops' learner (LOOP_RULES.profileTries
   * failures leave it out of what a look learns from). Cleared when a profile is kept.
   */
  styleProfileFails: z.number().int().min(0).max(9).nullable().optional(),
});
export type ImageAsset = z.infer<typeof ImageAssetSchema>;
