import { z } from "zod";
import { LOOPS, type LoopKind } from "@/lib/loops/registry";
import { AGENT_NAMES } from "./agentNames";

/**
 * The stamp (learning loops, ADR-0017's Stamp step): the one field every thing YouGrow makes keeps,
 * saying which kind made it, in which scope, with which learned version and on which arm. Writers
 * of made things take `made: LoopStamp | { unstamped: UnstampedReason }`, and records keep an
 * optional `made`. src/lib/loops/stamp.ts mints, signs and checks stamps; this file is only their
 * shape. Pure and client safe.
 *
 * A stamp holds no words, no person and no brand: only the made id travels (in a link or an
 * email's metadata), and it carries a scope, a version and an arm.
 */

/** The arm of the holdback a made thing was on (decision 3 of the plan for steps 4 and 5). */
export const LOOP_ARMS = ["learned", "holdback", "none"] as const;
export type LoopArm = (typeof LOOP_ARMS)[number];

/** Each arm's letter in a made id. */
export const ARM_LETTER: Record<LoopArm, "l" | "h" | "n"> = { learned: "l", holdback: "h", none: "n" };

/** The longest scope: the learned_pattern_versions channel it names is 40 characters at most. */
export const SCOPE_MAX_CHARS = 40;

/** A scope: lower case words joined by dots, such as `image_style.natural_photo`. */
export const SCOPE_RE = /^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/;

/**
 * A made id: `m1.<scope>.<version>.<l|h|n>`, with an optional 6 character keyed tail that
 * src/lib/loops/stamp.ts may add, under 64 characters. The scope may hold dots, so it is read from
 * the right.
 */
export const MADE_ID_RE = /^m1\.([a-z0-9_]+(?:\.[a-z0-9_]+)*)\.(\d{1,6})\.([lhn])(?:\.([a-z0-9]{6}))?$/;

export const MadeIdSchema = z.string().max(63).regex(MADE_ID_RE);
export type MadeId = z.infer<typeof MadeIdSchema>;

/**
 * What else fed the prompt, from a closed list: `refs:<n>` style references picked from votes,
 * `best_of:<n>` candidates, `legacy` (the look on the brand record, before the brand is seeded),
 * `person_off` ("Use learned brand style" unticked), `fallback_drawn` (a drawn or title card
 * fallback, or the painted twin when a drawn render failed) and `not_learning` (made on a path that
 * never learns, though it may read a look: a format's card, a drawn style's painted half, an edit
 * of an earlier image). The verdict leaves out every image with either of the last two.
 */
export const STAMP_SOURCE_RE = /^(?:refs:\d{1,2}|best_of:\d{1,2}|legacy|person_off|fallback_drawn|not_learning)$/;

/**
 * Why a writer kept no stamp, from a closed list, so each reason is counted. Step 4 uses the
 * first three; the rest are the reasons the plan names for the writers step 5 stamps, plus
 * `nothing_made` for a node save that wrote no new words, and the two the stamp scan found
 * (`chat_reply` and `learner`, in src/lib/agents/groundedMeter.test.ts).
 */
export const UNSTAMPED_REASONS = [
  /** LOOPS_ENABLED is off, for a kind that isn't an image kind. */
  "loops_off",
  /** IMAGE_STYLE_VERSIONS_ENABLED is off, for an image kind. */
  "image_versions_off",
  /** A person's own image (an upload), which YouGrow did not make. */
  "own_image",
  /** A save that only takes an image away. */
  "removes_image",
  /** A person restored an earlier version. */
  "person_restored",
  /** A person marked an article checked. */
  "person_marked_checked",
  /** A save that changes only dates. */
  "dates_only",
  /** A save that records where something is, such as a live address. */
  "records_where",
  /** Words a person wrote, sent as they wrote them. */
  "person_wrote",
  /** Send records are off, so there is no record to keep a stamp on (made is still counted). */
  "records_off",
  /** Numbers a connected product sent, which YouGrow did not make. */
  "connected_data",
  /** A route that only reads. */
  "reads_only",
  /** A route that only starts a worker, which stamps what it makes. */
  "starts_worker",
  /** A save that made nothing new on its record: a step with no words, or a write that failed. */
  "nothing_made",
  /** A chat reply, which is never saved: what Vizzy saves is stamped as its own kind of draft. */
  "chat_reply",
  /** A learner's own call: it writes a learned look or rule, judged by the loop it feeds. */
  "learner",
] as const;
export type UnstampedReason = (typeof UNSTAMPED_REASONS)[number];

/** The most bytes a stamp may take, so records and their indexes stay small. */
export const STAMP_MAX_BYTES = 512;

const isLoopKind = (k: string): k is LoopKind => Object.prototype.hasOwnProperty.call(LOOPS, k);

export const LoopStampSchema = z
  .object({
    made: MadeIdSchema,
    kind: z.string().max(40).refine(isLoopKind, "not a kind in the learning registry"),
    scope: z.string().max(SCOPE_MAX_CHARS).regex(SCOPE_RE),
    /** The learned version in force, holdback included; 0 before anything is learned. */
    v: z.number().int().min(0).max(999_999),
    arm: z.enum(LOOP_ARMS),
    /** The learned item ids in the block. */
    items: z.array(z.string().min(1).max(16)).max(8),
    /** The prompt's id, version and a hash of its text ('content.fill@2#a1b2c3'), from promptStamp. */
    prompt: z.string().max(80).nullable(),
    /** Tokens the learned block added. */
    tokens: z.object({ rules: z.number().int().min(0).max(99_999), examples: z.number().int().min(0).max(99_999) }),
    sources: z.array(z.string().regex(STAMP_SOURCE_RE)).max(4).optional(),
    /** The agent that made it, when one did. */
    by: z.enum(AGENT_NAMES).optional(),
    /** The first made thing upstream, such as the post a scheduled post came from. */
    root: MadeIdSchema.optional(),
    /** When it was made, ISO. */
    at: z.string().min(1).max(32),
  })
  .superRefine((s, ctx) => {
    const m = MADE_ID_RE.exec(s.made);
    if (m && (m[1] !== s.scope || Number(m[2]) !== s.v || m[3] !== ARM_LETTER[s.arm])) {
      ctx.addIssue({ code: "custom", path: ["made"], message: "the made id names another scope, version or arm" });
    }
    if (new TextEncoder().encode(JSON.stringify(s)).length > STAMP_MAX_BYTES) {
      ctx.addIssue({ code: "custom", message: `a stamp takes at most ${STAMP_MAX_BYTES} bytes` });
    }
  });
export type LoopStamp = Omit<z.infer<typeof LoopStampSchema>, "kind"> & { kind: LoopKind };

export const UnstampedSchema = z.object({ unstamped: z.enum(UNSTAMPED_REASONS) });
export type Unstamped = z.infer<typeof UnstampedSchema>;

/** What a record keeps in `made`: its stamp, or why it has none. */
export const MadeSchema = z.union([LoopStampSchema, UnstampedSchema]);
export type Made = LoopStamp | Unstamped;
