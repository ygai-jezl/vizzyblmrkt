import { canonicalStyleId } from "@/lib/content/imageStyle/catalogue";
import { isImageStyleVersionsOn } from "@/lib/content/imageStyle/flags";
import { fnv1a } from "@/lib/journey/allocation";
import { readBrandPointers } from "@/lib/tenant/loops";
import { getPatternVersion } from "@/lib/tenant/patternVersions";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { AgentName } from "@/lib/types/agentAction";
import type { LearnedPatternVersion } from "@/lib/types/learnedPatternVersion";
import type { BrandPointers, ScopePointer } from "@/lib/types/loopDay";
import { LoopStampSchema, type LoopArm, type LoopStamp, type Made, type MadeId } from "@/lib/types/loopStamp";
import { isLoopsEnabled } from "./flags";
import { isImageKind } from "./imageKinds";
import { IMAGE_STYLE_SCOPES, LOOP_RULES, LOOPS, type ImageStyleScope, type LoopKind } from "./registry";
import { madeIdOf, promptStamp } from "./stamp";

/**
 * The one reader of what was learned (learning loops step 4, 3.3 of the plan for steps 4 and 5):
 * `const { block, stamp } = await learnedFor(ctx, kind, { scope, outputId })`. A path reads it
 * once, puts the block in its prompt, settles the stamp where the image is made
 * (settleStamp in ./stamp.ts) and passes it to the record it writes. It never counts anything.
 *
 * - A kind that isn't an image kind: an empty block and no read. With LOOPS_ENABLED off,
 *   `{ unstamped: "loops_off" }` (decision 22); on (step 5, 4.1), a stamp at version 0, arm none,
 *   in its own scope (the kind's name unless a scope is given), since nothing but images learns
 *   through these steps yet.
 * - An image kind with IMAGE_STYLE_VERSIONS_ENABLED off: the look from the brand record the path
 *   already read, exactly as today, and `{ unstamped: "image_versions_off" }`, with no read.
 * - With it on, a kind or style that doesn't learn: no look and arm none, with no read.
 * - Otherwise `lb:`, then the version rows in use (the style's and the brand look's, at once):
 *   a look set by a person or kept, or a learned or carried over look, whichever the scope uses;
 *   then, for a painted style with no look of its own, the brand look (decision 10); then no look.
 *
 * Arms (decision 3): about 1 image in 20 per scope is held back, by a hash of its id, from a look
 * learned from votes or carried over, never from a look a person set or kept, and never for a
 * brand that opted out. "Use learned brand style" unticked is arm none with `person_off`, and a
 * brand not yet seeded uses the old field, arm none with `legacy`. A pause changes nothing here.
 */

export { IMAGE_KINDS, isImageKind, type ImageKind } from "./imageKinds";

/** The brand look's scope, which a painted style with no look of its own uses. */
export const BRAND_SCOPE = "image_style.brand" satisfies ImageStyleScope;

const isLearningScope = (scope: string): scope is ImageStyleScope => (IMAGE_STYLE_SCOPES as readonly string[]).includes(scope);

/**
 * The scope an image's look comes from: `image_style.<style>` for its style (an old style id maps
 * to the style it became), or the brand look when it has none. A drawn style gets a scope of its
 * own that never learns, so its images stamp arm none.
 */
export function imageScopeOf(styleId: string | null | undefined): string {
  const id = canonicalStyleId(styleId);
  return id ? `image_style.${id}` : BRAND_SCOPE;
}

/** The holdback (decision 3): FNV-1a over the image's id, salted with the scope, so about 1 in LOOP_RULES.holdbackOneIn per scope. */
export function isHeldBack(scope: string, outputId: string): boolean {
  return fnv1a(`${scope}|${outputId}`) % LOOP_RULES.holdbackOneIn === 0;
}

/** What a path puts in its prompt. */
export interface LearnedBlock {
  /**
   * The look's words for the image prompt (assembleBrandContext's learnedImageStyle): a look, null
   * for none, or undefined for the brand context's own default. Only the old look a path passes in
   * can be undefined, so with versions off, or before a brand is seeded, images are made as today.
   */
  look: string | null | undefined;
  /** Held back: leave out the style references picked from votes too. */
  holdback: boolean;
}

export interface LearnedRead {
  block: LearnedBlock;
  stamp: Made;
}

export interface LearnedForOptions {
  /** Where it learns: for an image, imageScopeOf(its style). The brand look when left out. */
  scope?: string;
  /** The new output's id, minted before this read (newImageAssetId for an image), for the holdback's hash. No id, no holdback. */
  outputId?: string;
  /** "Use learned brand style": false means the person left what was learned out. */
  useBrandStyle?: boolean;
  /** The look from the brand record the path already read, used with versions off and before seeding. */
  legacy?: string | null;
  /** The prompt the output is made with, for the stamp's prompt part. */
  promptId?: string;
  /** The agent making it, when one is. */
  by?: AgentName;
  /** The first made thing upstream. */
  root?: MadeId;
}

export interface LearnedForDeps {
  db?: FirestoreLike;
  now?: Date;
}

/** No block: nothing learned reaches the prompt. */
export const EMPTY_BLOCK: LearnedBlock = Object.freeze({ look: null, holdback: false });

type StampBase = Pick<LoopStamp, "kind" | "prompt" | "at"> & Partial<Pick<LoopStamp, "by" | "root">>;

/** A look's tokens, at about 4 characters each. */
const tokensOf = (text: string): number => Math.min(99_999, Math.ceil(text.length / 4));

function stampOf(
  base: StampBase,
  scope: string,
  v: number,
  arm: LoopArm,
  more: { item?: string; look?: string | null; sources?: string[] } = {},
): LoopStamp {
  return LoopStampSchema.parse({
    ...base,
    made: madeIdOf(scope, v, arm),
    scope,
    v,
    arm,
    items: more.item ? [more.item] : [],
    tokens: { rules: typeof more.look === "string" ? tokensOf(more.look) : 0, examples: 0 },
    ...(more.sources ? { sources: more.sources } : {}),
  }) as LoopStamp;
}

/** A version row's look: its one rule item with words, or none (an Undo of a first look, or a Forget). */
function lookOf(row: LearnedPatternVersion | null): { id: string; text: string } | null {
  const item = row?.items?.find((i) => i.type === "rule" && typeof i.text === "string" && i.text.trim().length > 0);
  return item ? { id: item.id, text: item.text! } : null;
}

/** Looks learned from votes, carried over, or (from step 9) learned across brands are held back; a look a person set or kept never is. */
function canHoldBack(pointer: ScopePointer, pointers: BrandPointers): boolean {
  return !pointers.fleetOptOut && !pointer.keptAt && pointer.setBy !== "person";
}

/** Before seeding, or when the loops' own read failed: the old field, as today, arm none with `legacy`. */
function legacyRead(base: StampBase, scope: string, legacy: string | null | undefined): LearnedRead {
  return { block: { look: legacy, holdback: false }, stamp: stampOf(base, scope, 0, "none", { look: legacy, sources: ["legacy"] }) };
}

/**
 * The stamp of an image made on a path that never learns, with no read (decision 10 and 3.6): a
 * drawn style, a format's card, or a drawn eBook cover. Arm none at version 0 in the scope of the
 * style it was drawn in, with `not_learning`, so no check counts it. With versions off,
 * `image_versions_off`; it is for images only, so any other kind gets `loops_off` (learnedFor
 * stamps those).
 */
export function notLearningStamp(kind: LoopKind, opts: Pick<LearnedForOptions, "scope" | "promptId" | "by" | "root"> = {}, deps: Pick<LearnedForDeps, "now"> = {}): Made {
  if (!isImageKind(kind)) return { unstamped: "loops_off" };
  if (!isImageStyleVersionsOn()) return { unstamped: "image_versions_off" };
  return stampOf(baseOf(kind, opts, deps), opts.scope ?? BRAND_SCOPE, 0, "none", { sources: ["not_learning"] });
}

function baseOf(kind: LoopKind, opts: Pick<LearnedForOptions, "promptId" | "by" | "root">, deps: Pick<LearnedForDeps, "now">): StampBase {
  return {
    kind,
    prompt: opts.promptId ? promptStamp(opts.promptId) : null,
    at: (deps.now ?? new Date()).toISOString(),
    ...(opts.by ? { by: opts.by } : {}),
    ...(opts.root ? { root: opts.root } : {}),
  };
}

export async function learnedFor(ctx: TenantContext, kind: LoopKind, opts: LearnedForOptions = {}, deps: LearnedForDeps = {}): Promise<LearnedRead> {
  if (!isImageKind(kind)) {
    // Off is today exactly (decision 22). On, every other kind is stamped arm none with no read:
    // none, gap, own and fleet lines learn nothing through this reader yet (4.1).
    if (!isLoopsEnabled()) return { block: EMPTY_BLOCK, stamp: { unstamped: "loops_off" } };
    return { block: EMPTY_BLOCK, stamp: stampOf(baseOf(kind, opts, deps), opts.scope ?? kind, 0, "none") };
  }
  if (!isImageStyleVersionsOn()) return { block: { look: opts.legacy, holdback: false }, stamp: { unstamped: "image_versions_off" } };

  const scope = opts.scope ?? BRAND_SCOPE;
  const base = baseOf(kind, opts, deps);
  const line = LOOPS[kind];
  if (!("loop" in line) || !(line.loop.scopes as readonly string[]).includes(scope) || !isLearningScope(scope)) {
    // A none line (Customise, carousels) or a drawn style: nothing learned, so nothing to read.
    return { block: EMPTY_BLOCK, stamp: stampOf(base, scope, 0, "none") };
  }

  let pointers: BrandPointers | null = null;
  try {
    pointers = await readBrandPointers(ctx, deps.db);
  } catch (err) {
    console.warn(`[loops] learnedFor ${kind}: reading the brand's pointers failed, so it uses the old look unless the person left looks out`, err instanceof Error ? err.message : err);
  }

  const own = pointers?.scopes[scope];
  if (opts.useBrandStyle === false) {
    return { block: EMPTY_BLOCK, stamp: stampOf(base, scope, own?.v ?? 0, "none", { sources: ["person_off"] }) };
  }
  if (!pointers?.seededAt) return legacyRead(base, scope, opts.legacy);

  const brand = scope === BRAND_SCOPE ? undefined : pointers.scopes[BRAND_SCOPE];
  let rows: [LearnedPatternVersion | null, LearnedPatternVersion | null];
  try {
    rows = await Promise.all([
      own && own.v > 0 ? getPatternVersion(ctx, scope, own.v, deps.db) : Promise.resolve(null),
      brand && brand.v > 0 ? getPatternVersion(ctx, BRAND_SCOPE, brand.v, deps.db) : Promise.resolve(null),
    ]);
  } catch (err) {
    console.warn(`[loops] learnedFor ${kind}: reading the looks in use failed, so the old look is used`, err instanceof Error ? err.message : err);
    return legacyRead(base, scope, opts.legacy);
  }

  const ownLook = lookOf(rows[0]);
  const brandLook = ownLook ? null : lookOf(rows[1]);
  const use = ownLook && own ? { scope, pointer: own, look: ownLook } : brandLook && brand ? { scope: BRAND_SCOPE, pointer: brand, look: brandLook } : null;
  if (!use) return { block: EMPTY_BLOCK, stamp: stampOf(base, scope, own?.v ?? 0, "none") };

  if (opts.outputId && canHoldBack(use.pointer, pointers) && isHeldBack(use.scope, opts.outputId)) {
    return { block: { look: null, holdback: true }, stamp: stampOf(base, use.scope, use.pointer.v, "holdback") };
  }
  return {
    block: { look: use.look.text, holdback: false },
    stamp: stampOf(base, use.scope, use.pointer.v, "learned", { item: use.look.id, look: use.look.text }),
  };
}
