import { z } from "zod";
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
export const ImageAssetKind = z.enum(["social", "ebook", "customized", "upload"]);
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
});
export type ImageAsset = z.infer<typeof ImageAssetSchema>;
