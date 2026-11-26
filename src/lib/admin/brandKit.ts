import { randomUUID } from "node:crypto";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { WhereClause } from "@/lib/tenant/repository";
import type { Region } from "@/lib/types/tenant";
import { ImageAssetSchema, type ImageAsset } from "@/lib/types/imageAsset";
import type { Made } from "@/lib/types/loopStamp";
import { isImageStyleVersionsOn } from "@/lib/content/imageStyle/flags";
import { countImageVote } from "@/lib/loops/imageRows";
import { isVoteReason, VOTE_NOTE_CHARS } from "@/lib/loops/reasons";
import { textRefusalOf } from "@/lib/loops/textCheck";

export const BRAND_KIT_PAGE_SIZE = 60;

export interface ListImagesParams {
  /** Keyset cursor: the createdAt of the last row of the previous page. */
  cursor?: string;
  /** Optional primary filter by ImageAsset.kind (needs the (tenantId, kind, createdAt) index). */
  kind?: string;
  limit?: number;
}

export interface ListResult<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * List the tenant's image assets for the Brand Kit gallery, newest first, keyset-
 * paginated over createdAt. Backed by the (tenantId, createdAt) composite index (and
 * (tenantId, kind, createdAt) when `kind` is set). The RSC caller wraps this in a
 * try/catch and degrades to an empty gallery while an index is still building.
 *
 * NOTE: the cursor is the single createdAt value (no unique tiebreaker), matching the
 * CRM list pattern in src/lib/admin/crm.ts. If several images share the EXACT same
 * millisecond createdAt AND that group straddles a page boundary, startAfter([createdAt])
 * excludes the whole tie group, so the overflow ties won't appear on the next page (a
 * rare, no-data-loss edge — the docs/bytes still exist). If this ever matters, add a
 * unique tiebreak (store the doc id as a field, order by [createdAt desc, id desc], and
 * carry both in the cursor) plus the matching composite index.
 */
export async function listImageAssets(
  ctx: TenantContext,
  params: ListImagesParams = {},
): Promise<ListResult<ImageAsset>> {
  const limit = Math.min(params.limit ?? BRAND_KIT_PAGE_SIZE, 200);
  const where: WhereClause[] = [];
  if (params.kind) where.push(["kind", "==", params.kind]);

  const rows = await forTenant(ctx).imageAssets.find({
    where,
    orderBy: [["createdAt", "desc"]],
    startAfter: params.cursor ? [params.cursor] : undefined,
    limit: limit + 1,
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? (items[items.length - 1]!.createdAt ?? null) : null;
  return { items, nextCursor };
}

/** Fetch one image asset (tenant-safe: getById re-checks the stored tenantId). */
export async function getImageAsset(
  ctx: TenantContext,
  id: string,
): Promise<ImageAsset | null> {
  return forTenant(ctx).imageAssets.getById(id);
}

export async function deleteImageAsset(ctx: TenantContext, id: string): Promise<void> {
  await forTenant(ctx).imageAssets.delete(id);
}

/**
 * Patch an image asset (tenant-scoped update re-verifies ownership + strips
 * tenantId/id/createdAt). Returns the fresh row, or null if it doesn't exist for
 * this tenant. Used by the brand-style feedback loop (vote + styleProfile writes).
 */
export async function updateImageAsset(
  ctx: TenantContext,
  id: string,
  patch: Partial<Omit<ImageAsset, "id" | "tenantId" | "createdAt">>,
): Promise<ImageAsset | null> {
  const existing = await forTenant(ctx).imageAssets.getById(id);
  if (!existing) return null;
  await forTenant(ctx).imageAssets.update(id, patch);
  return { ...existing, ...patch };
}

/**
 * Record (or clear) the operator's brand-fit verdict on an image. A vote stamps
 * `brandVoteSetAt`; a 👎 or a clear (null) drops the numeric rating. Idempotent.
 *
 * With image style versions on (learning loops step 4), in one transaction it also keeps how the
 * verdict was given (`brandVoteVia: "vote"`), when the image was first voted on (`firstVotedAt`,
 * set once and never reset), and clears the reason and note when the vote changes (3.11); then it
 * counts the vote against the image's stamp, so a changed vote moves the counts and each image
 * counts once. With them off the row is written exactly as before.
 */
export async function setImageBrandVote(
  ctx: TenantContext,
  id: string,
  input: { vote: "up" | "down" | null; rating?: number | null },
  deps: { now?: Date } = {},
): Promise<ImageAsset | null> {
  const vote = input.vote;
  const rating = vote === "up" ? (input.rating ?? null) : null;
  const now = deps.now ?? new Date();
  if (!isImageStyleVersionsOn()) {
    return updateImageAsset(ctx, id, {
      brandVote: vote,
      brandRating: rating,
      brandVoteSetAt: vote ? now.toISOString() : null,
    });
  }
  // The row as the transaction read it (closures aren't narrowed, hence the holder).
  const seen: { before: ImageAsset | null } = { before: null };
  const after = await forTenant(ctx).imageAssets.claim(id, (current) => {
    seen.before = current;
    const changed = (current.brandVote ?? null) !== vote;
    return {
      brandVote: vote,
      brandRating: rating,
      brandVoteSetAt: vote ? now.toISOString() : null,
      brandVoteVia: vote ? "vote" : null,
      ...(vote && !current.firstVotedAt ? { firstVotedAt: firstVoteOf(current, now) } : {}),
      ...(changed ? { brandVoteReason: null, brandVoteNote: null, brandVoteReasonAt: null } : {}),
    };
  });
  if (!after || !seen.before) return null;
  await countImageVote(ctx, seen.before, after, { now });
  return after;
}

/**
 * When an image was first voted on, for a row that has no firstVotedAt yet: now, or for a row
 * voted before versions came on, when it was made, so re-rating an old like never counts as a new
 * one.
 */
function firstVoteOf(row: ImageAsset, now: Date): string {
  return row.brandVote ? row.createdAt : now.toISOString();
}

/** Why a reason or note wasn't kept. */
export type VoteReasonRefusal = "not_found" | "no_vote" | "invalid_reason" | "note_refused";

export type VoteReasonResult = { ok: true; image: ImageAsset } | { ok: false; error: VoteReasonRefusal };

/** A note as kept: plain text on one line, its spaces collapsed, at most VOTE_NOTE_CHARS; empty is none. */
export function cleanVoteNote(note: string | null | undefined): string | null {
  const t = (note ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, VOTE_NOTE_CHARS) : null;
}

/**
 * Keep the why behind the image's vote (3.11 of the plan for steps 4 and 5): one reason key for
 * the vote's direction (VOTE_REASONS.image), and an optional note, which passes the loops' text
 * check (no links, email addresses, handles or phone numbers). A null reason clears both. The
 * reason moves the image's `liked.<reason>` or `disliked.<reason>` count once. Only with image
 * style versions on; the caller checks the switch.
 */
export async function setImageVoteReason(
  ctx: TenantContext,
  id: string,
  input: { reason: string | null; note?: string | null },
  deps: { now?: Date } = {},
): Promise<VoteReasonResult> {
  const now = deps.now ?? new Date();
  const note = cleanVoteNote(input.note);
  if (note && !input.reason) return { ok: false, error: "invalid_reason" };
  if (note && textRefusalOf(note)) return { ok: false, error: "note_refused" };

  const seen: { before: ImageAsset | null; refused: VoteReasonRefusal | null } = { before: null, refused: null };
  const after = await forTenant(ctx).imageAssets.claim(id, (current) => {
    seen.before = current;
    seen.refused = null;
    if (!current.brandVote) {
      seen.refused = "no_vote";
      return null;
    }
    if (input.reason && !isVoteReason("image", current.brandVote, input.reason)) {
      seen.refused = "invalid_reason";
      return null;
    }
    return {
      brandVoteReason: (input.reason ?? null) as ImageAsset["brandVoteReason"],
      brandVoteNote: input.reason ? note : null,
      brandVoteReasonAt: input.reason ? now.toISOString() : null,
      // A vote from before versions is counted with its first reason.
      ...(current.firstVotedAt ? {} : { firstVotedAt: firstVoteOf(current, now) }),
    };
  });
  if (seen.refused) return { ok: false, error: seen.refused };
  if (!after || !seen.before) return { ok: false, error: "not_found" };
  await countImageVote(ctx, seen.before, after, { now });
  return { ok: true, image: after };
}

/**
 * The tenant's positive brand exemplars (👍), highest-rated first then newest.
 * Backs the L1 style synthesis and the L2 reference-image pool. Needs the
 * (tenantId, brandVote, brandRating desc, createdAt desc) composite index.
 */
export async function listBrandExemplars(
  ctx: TenantContext,
  params: { minRating?: number; limit?: number } = {},
): Promise<ImageAsset[]> {
  const rows = await forTenant(ctx).imageAssets.find({
    where: [["brandVote", "==", "up"]],
    orderBy: [
      ["brandRating", "desc"],
      ["createdAt", "desc"],
    ],
    limit: Math.min(params.limit ?? 20, 100),
  });
  const min = params.minRating ?? 0;
  return min > 0 ? rows.filter((r) => (r.brandRating ?? 0) >= min) : rows;
}

/** The tenant's negative exemplars (👎) — off-brand traits to steer away from. */
export async function listBrandNegatives(
  ctx: TenantContext,
  params: { limit?: number } = {},
): Promise<ImageAsset[]> {
  return forTenant(ctx).imageAssets.find({
    where: [["brandVote", "==", "down"]],
    orderBy: [["createdAt", "desc"]],
    limit: Math.min(params.limit ?? 8, 50),
  });
}

export type RecordImageInput = Omit<ImageAsset, "id" | "tenantId" | "createdAt" | "made"> & {
  /**
   * The id minted with newImageAssetId before learnedFor ran, so the holdback's hash and the row
   * name the same image (learning loops step 4, decision 3). Minted here when left out.
   */
  id?: string;
  /** Its stamp from learnedFor, settled where it was made, or why it has none (decision 19). */
  made?: Made;
};

/** A new image's id, minted before learnedFor runs (learning loops step 4) and passed to recordImageAsset. */
export function newImageAssetId(): string {
  return randomUUID();
}

/** An image id is a document id: letters, digits, underscores and hyphens only. */
const IMAGE_ASSET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Persist a generated image into the registry. Called from the creative service with a
 * minimal { tenantId, region } scope (enough for forTenant). THROWS on failure — the
 * Customise flow wants the record to succeed. Generation-path callers wrap this in
 * `.catch(...)` so a Firestore blip never fails an already-stored image.
 *
 * Its stamp (`made`), and an upload's `brandVoteVia` and `firstVotedAt`, are kept only while image
 * style versions are on, so with them off the row is exactly as before (decision 22). The id it
 * was given is refused if a row already has it.
 */
export async function recordImageAsset(
  scope: { tenantId: string; region: Region },
  input: RecordImageInput,
): Promise<ImageAsset> {
  const { id: given, made, brandVoteVia, firstVotedAt, ...rest } = input;
  const id = given ?? newImageAssetId();
  if (!IMAGE_ASSET_ID_RE.test(id)) throw new Error("recordImageAsset needs an image id of letters, digits, underscores and hyphens");
  const versions = isImageStyleVersionsOn();
  const doc = ImageAssetSchema.parse({
    ...rest,
    ...(versions && made ? { made } : {}),
    ...(versions && brandVoteVia ? { brandVoteVia } : {}),
    ...(versions && firstVotedAt ? { firstVotedAt } : {}),
    id,
    tenantId: scope.tenantId,
    createdAt: new Date().toISOString(),
  });
  const ctx: TenantContext = {
    tenantId: scope.tenantId,
    region: scope.region,
    source: "system",
  };
  return forTenant(ctx).imageAssets.create(id, doc);
}
