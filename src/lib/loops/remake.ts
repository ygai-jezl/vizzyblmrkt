import type { AiUsage } from "@/lib/agents/gemini";
import { isImageStyleVersionsOn } from "@/lib/content/imageStyle/flags";
import { aiUsage } from "@/lib/plans/meter";
import type { ResourcePurpose } from "@/lib/plans/resources";
import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { ImageAsset } from "@/lib/types/imageAsset";
import type { Tenant } from "@/lib/types/tenant";
import { countSignal } from "./count";
import { stampOfImage } from "./imageRows";
import { LOOP_RULES } from "./registry";

/**
 * Remakes (learning loops step 4, decisions 3 and 12 of the plan for steps 4 and 5). A remake is a
 * person making a new image in the same place as an earlier one: a post's image, a blog hero's
 * Make again, or an eBook slot or cover. Email images, email heroes and carousels never count one.
 *
 * Before the new image is made, the route reads the earlier image's row by brand and filename (two
 * equality filters, no composite index) with readRemake. A remake counts only within
 * LOOP_RULES.outcomeDays of the earlier image, and only once, so each image's outcome is fixed 14
 * days after it was made. The first remake of a held back image is metered under loop_learn, which
 * never counts toward the image allowance, so the holdback costs a brand nothing. That free remake
 * is reserved on the earlier row in a transaction before the new image is made, so of several at
 * once only the one that reserved it is free; the others are metered under their own kind. The
 * reservation lapses after REMAKE_HOLD_MS, so an image that failed lets it go. Once the new image
 * is stored, recordRemake marks the earlier row remade and counts it. Server only.
 */

/** Where a new image can be a remake of the one before it. */
export const REMAKE_KINDS = ["post_image", "blog_hero", "ebook_image"] as const;
export type RemakeKind = (typeof REMAKE_KINDS)[number];

const DAY_MS = 86_400_000;

/** How long a request holds a held back image's free remake while it makes the new image. */
export const REMAKE_HOLD_MS = 5 * 60_000;

export interface Remake {
  kind: RemakeKind;
  /** The earlier image's row, when this brand recorded one under that filename. */
  earlier: ImageAsset | null;
  /** Whether making the new one counts as this image's remake: within 14 days, and its first. */
  counts: boolean;
  /** What the new image is metered under: loop_learn for the first remake of a held back image, else the kind. */
  purpose: ResourcePurpose;
}

export interface RemakeDeps {
  db?: FirestoreLike;
  now?: Date;
}

const noRemake = (kind: RemakeKind): Remake => ({ kind, earlier: null, counts: false, purpose: kind });

/** Whether an image made at `createdAt` can still count a remake at `now`. */
export function withinOutcomeDays(createdAt: string, now: Date): boolean {
  const age = now.getTime() - Date.parse(createdAt);
  return Number.isFinite(age) && age >= 0 && age <= LOOP_RULES.outcomeDays * DAY_MS;
}

const isHeldBack = (row: ImageAsset) => Boolean(row.made && !("unstamped" in row.made) && row.made.arm === "holdback");

/** Whether another request holds the image's free remake now. */
function heldNow(row: ImageAsset, now: Date): boolean {
  const held = row.remakeClaimAt ? now.getTime() - Date.parse(row.remakeClaimAt) : Number.NaN;
  return Number.isFinite(held) && held >= 0 && held < REMAKE_HOLD_MS;
}

/** Reserve a held back image's one free remake for this request; false when it was remade or another request holds it. */
async function reserve(ctx: TenantContext, id: string, now: Date, db?: FirestoreLike): Promise<boolean> {
  try {
    const won = await forTenant(ctx, db).imageAssets.claim(id, (current) =>
      current.remadeAt || !withinOutcomeDays(current.createdAt, now) || !isHeldBack(current) || heldNow(current, now) ? null : { remakeClaimAt: now.toISOString() },
    );
    return Boolean(won);
  } catch (err) {
    console.warn("[loops] reserving a held back image's remake failed, so it is metered as usual", err instanceof Error ? err.message.slice(0, 200) : "error");
    return false;
  }
}

/**
 * Before a new image is made in the place of `earlierFilename`: the earlier image's row and what
 * the new one is metered under. With versions off, or no earlier image, or a read that fails, it
 * is no remake and the new image is metered under its own kind, exactly as before.
 */
export async function readRemake(ctx: TenantContext, kind: RemakeKind, earlierFilename: string | null | undefined, deps: RemakeDeps = {}): Promise<Remake> {
  if (!(REMAKE_KINDS as readonly string[]).includes(kind)) return noRemake(kind);
  if (!isImageStyleVersionsOn() || !earlierFilename) return noRemake(kind);
  let earlier: ImageAsset | null = null;
  try {
    const rows = await forTenant(ctx, deps.db).imageAssets.find({ where: [["filename", "==", earlierFilename]], limit: 1 });
    earlier = rows[0] ?? null;
  } catch (err) {
    console.warn("[loops] reading the image a new one replaces failed, so it is not counted as a remake", err instanceof Error ? err.message.slice(0, 200) : "error");
    return noRemake(kind);
  }
  if (!earlier) return noRemake(kind);
  const now = deps.now ?? new Date();
  const counts = !earlier.remadeAt && withinOutcomeDays(earlier.createdAt, now);
  // Only the request that reserves it is free: of two remakes at once, the other is metered as usual.
  const free = counts && isHeldBack(earlier) && (await reserve(ctx, earlier.id, now, deps.db));
  return { kind, earlier, counts, purpose: free ? "loop_learn" : kind };
}

/**
 * The meter a new image in the place of an earlier one spends under: its kind, or loop_learn for
 * the first remake of a held back image within 14 days, which never counts toward the image
 * allowance (decision 3). The route reads the remake first, then makes the image with this.
 */
export function remakeUsage(ctx: TenantContext, remake: Remake, opts: { tenant?: Tenant | null } = {}): AiUsage {
  return aiUsage(ctx, remake.purpose, opts);
}

/**
 * Once the new image is stored: mark the earlier row remade by it and count remade against the
 * earlier image's stamp, when this remake counts. The mark is taken in a transaction, so of two
 * remakes at once only one counts. Never throws; true when it counted.
 */
export async function recordRemake(ctx: TenantContext, remake: Remake, newImageId: string, deps: RemakeDeps = {}): Promise<boolean> {
  const earlier = remake.earlier;
  if (!remake.counts || !earlier || !newImageId || newImageId === earlier.id) return false;
  try {
    const now = deps.now ?? new Date();
    const marked = await forTenant(ctx, deps.db).imageAssets.claim(earlier.id, (current) =>
      current.remadeAt || !withinOutcomeDays(current.createdAt, now) ? null : { remadeAt: now.toISOString(), remadeBy: newImageId, ...(current.remakeClaimAt ? { remakeClaimAt: null } : {}) },
    );
    if (!marked) return false;
    const stamp = await stampOfImage(ctx, marked, { db: deps.db });
    if (stamp) await countSignal(ctx, stamp, "remade", { db: deps.db, now });
    return true;
  } catch (err) {
    console.warn("[loops] marking an image remade failed", err instanceof Error ? err.message.slice(0, 200) : "error");
    return false;
  }
}
