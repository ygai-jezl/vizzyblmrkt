import { readBrandPointers } from "@/lib/tenant/loops";
import { getPatternVersion } from "@/lib/tenant/patternVersions";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { ImageAsset, ImageAssetKind } from "@/lib/types/imageAsset";
import { LoopStampSchema, type LoopStamp } from "@/lib/types/loopStamp";
import { countSignals, type CountDeps, type CountedSignal } from "./count";
import { imageScopeOf } from "./read";
import { IMAGE_STYLE_SCOPES, type LoopKind } from "./registry";
import { madeIdOf } from "./stamp";

/**
 * What the loops read off an image's row (learning loops step 4): the stamp its signals are
 * counted against, and a vote's signals, so a changed vote moves the counts and each image counts
 * once (3.1 and 3.4 of the plan for steps 4 and 5). Server only.
 */

/** The kind that made an image of each library kind; an upload is a person's own, made by no kind. */
const KIND_OF_ROW: Record<ImageAssetKind, LoopKind | null> = {
  social: "post_image",
  blog_hero: "blog_hero",
  ebook: "ebook_image",
  customized: "customize_image",
  upload: null,
};

export interface ImageRowDeps {
  db?: FirestoreLike;
}

const isLearningScope = (scope: string) => (IMAGE_STYLE_SCOPES as readonly string[]).includes(scope);

/**
 * The stamp an image's signals count against: its own, or for a row from before versions, one
 * worked out from it (3.4): its style's scope, arm none, marked legacy, and version 1 when the row
 * was made before the brand was seeded and its style's version 1 is the carried over look, else
 * version 0. Null for a person's own image or a row kept with no stamp, which count nothing.
 */
export async function stampOfImage(ctx: TenantContext, row: ImageAsset, deps: ImageRowDeps = {}): Promise<LoopStamp | null> {
  if (row.made) return "unstamped" in row.made ? null : (row.made as LoopStamp);
  const kind = KIND_OF_ROW[row.kind];
  if (!kind) return null;
  const scope = imageScopeOf(row.style);
  let v = 0;
  if (isLearningScope(scope)) {
    try {
      const pointers = await readBrandPointers(ctx, deps.db);
      if (pointers.seededAt && row.createdAt < pointers.seededAt) {
        const first = await getPatternVersion(ctx, scope, 1, deps.db);
        if (first?.setBy === "seeded") v = 1;
      }
    } catch (err) {
      console.warn("[loops] reading the seed for an image from before versions failed, so it counts as version 0", err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  const s = LoopStampSchema.safeParse({
    made: madeIdOf(scope, v, "none"),
    kind,
    scope,
    v,
    arm: "none",
    items: [],
    prompt: null,
    tokens: { rules: 0, examples: 0 },
    sources: ["legacy"],
    at: row.createdAt,
  });
  return s.success ? (s.data as LoopStamp) : null;
}

/** The vote fields the counts read. */
export type VoteState = Pick<ImageAsset, "brandVote" | "brandVoteReason" | "firstVotedAt">;

/** What a row's vote stands for in the counts: voted, liked when up, and its reason. */
export function voteSignals(row: VoteState): Partial<Record<CountedSignal, number>> {
  if (!row.brandVote) return {};
  const out: Partial<Record<CountedSignal, number>> = { voted: 1 };
  if (row.brandVote === "up") out.liked = 1;
  if (row.brandVoteReason) out[`${row.brandVote === "up" ? "liked" : "disliked"}.${row.brandVoteReason}`] = 1;
  return out;
}

/**
 * How the counts move from one vote to the next. A row with `firstVotedAt` has had its vote
 * counted since versions came on; a row without one was voted before, or never, so nothing of it
 * was counted and its whole new vote is. Re-rating a like moves nothing: liked counts a first up
 * vote only.
 */
export function voteDeltas(before: VoteState, after: VoteState): Partial<Record<CountedSignal, number>> {
  const was = before.firstVotedAt ? voteSignals(before) : {};
  const now = voteSignals(after);
  const out: Partial<Record<CountedSignal, number>> = {};
  for (const k of new Set([...Object.keys(was), ...Object.keys(now)]) as Set<CountedSignal>) {
    const n = (now[k] ?? 0) - (was[k] ?? 0);
    if (n !== 0) out[k] = n;
  }
  return out;
}

/** Count a vote, or its reason, against the image's stamp. Never throws. */
export async function countImageVote(ctx: TenantContext, before: ImageAsset, after: ImageAsset, deps: CountDeps = {}): Promise<void> {
  try {
    const deltas = voteDeltas(before, after);
    if (Object.keys(deltas).length === 0) return;
    const stamp = await stampOfImage(ctx, after, deps);
    if (stamp) await countSignals(ctx, stamp, deltas, deps);
  } catch (err) {
    console.warn("[loops] counting a vote failed", err instanceof Error ? err.message.slice(0, 200) : "error");
  }
}
