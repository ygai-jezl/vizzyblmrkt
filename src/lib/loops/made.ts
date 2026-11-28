import type { Made, MadeId } from "@/lib/types/loopStamp";
import { isLoopsEnabled } from "./flags";
import { isImageKind } from "./imageKinds";

/**
 * What the writers of step 5 keep in `made` (learning loops step 5, 4.1 and 4.2 of the plan for
 * steps 4 and 5). Each of the seven writers takes a required `made: LoopStamp | { unstamped }`,
 * so a new caller can't forget to say what made its record, and keeps it only with LOOPS_ENABLED
 * on: off, every record is written exactly as before (decision 22). Pure apart from the switch.
 */

/** The reasons a switch gives, which no record keeps: off is today exactly. */
const OFF_REASONS: ReadonlySet<string> = new Set(["loops_off", "image_versions_off"]);

/** What a record keeps in `made`, or undefined to leave the field out: nothing with LOOPS_ENABLED off. */
export function keptMade(made: Made | null | undefined): Made | undefined {
  if (!made || !isLoopsEnabled()) return undefined;
  if ("unstamped" in made && OFF_REASONS.has(made.unstamped)) return undefined;
  return made;
}

/** The made id of a stamp, for the next stamp's `root` (the first made thing upstream); none for an unstamped thing. */
export function rootOf(made: Made | null | undefined): MadeId | undefined {
  return made && !("unstamped" in made) ? (made.root ?? made.made) : undefined;
}

/** A stamp with its `root` set (the first made thing upstream), such as an email's AI line; anything else as it is. */
export function withRoot(made: Made, root: MadeId | undefined): Made {
  if (!root || "unstamped" in made) return made;
  return { ...made, root };
}

/** Whether two values hold the same stamp (the same made id): a write handing back the stamp already kept. */
export function sameStamp(a: Made | null | undefined, b: Made | null | undefined): boolean {
  return Boolean(a && b && !("unstamped" in a) && !("unstamped" in b) && a.made === b.made);
}

/** A content plan node's two stamps: what made its words (`made`) and its image (`imageMade`). */
export interface NodeStamps {
  made?: Made;
  imageMade?: Made;
}

/** Saves that leave both of a node's stamps as they were: they made nothing new on it. */
const KEEPS_BOTH: ReadonlySet<string> = new Set(["dates_only", "records_where", "person_marked_checked"]);
/** Saves about the node's image. */
const IMAGE_REASONS: ReadonlySet<string> = new Set(["own_image", "removes_image"]);

/** What a node write changed: its words (`body`) and its image (`imageAssetRef`). */
export interface NodeWriteTouches {
  body: boolean;
  image: boolean;
}

/**
 * A node's stamps after a write through updateContentPlanNode, from the ones stored, the write's
 * `made` and what the write changed. An image's stamp (an image kind) becomes `imageMade` when the
 * write sets the image, and any other stamp becomes `made` when it sets the words, so a new image
 * or a brief never takes the words' stamp away. A person's own image replaces the image's stamp
 * and an image taken away removes it; a person's own words (a restored version) replace the
 * words'. A save that only records dates, where something is or a check keeps both, and words
 * written with nothing made take the words' stamp away. With LOOPS_ENABLED off (or an image made
 * with image style versions off) no new stamp is kept, and a field the write changes loses its
 * stored one, as that stamp is of words or an image the node no longer holds: once the switch is
 * back on, nothing answers a made thing that was never counted. A write handing back the very
 * stamp stored (a fact check revising stamped words) keeps it.
 */
export function nodeStampsAfter(stored: NodeStamps, made: Made, touched: NodeWriteTouches): NodeStamps {
  const out: NodeStamps = { ...(stored.made ? { made: stored.made } : {}), ...(stored.imageMade ? { imageMade: stored.imageMade } : {}) };
  const keep = keptMade(made);
  if (!keep) {
    if (touched.body && !sameStamp(made, out.made)) delete out.made;
    if (touched.image && !sameStamp(made, out.imageMade)) delete out.imageMade;
    return out;
  }
  if ("unstamped" in keep) {
    if (KEEPS_BOTH.has(keep.unstamped)) return out;
    // No new words (a failed write empties the node, a step has none): the old words' stamp goes with them.
    if (keep.unstamped === "nothing_made") {
      if (touched.body) delete out.made;
      return out;
    }
    if (IMAGE_REASONS.has(keep.unstamped)) {
      if (keep.unstamped === "removes_image") delete out.imageMade;
      else out.imageMade = keep;
      return out;
    }
    if (touched.body) out.made = keep;
    return out;
  }
  if (isImageKind(keep.kind)) {
    if (touched.image) out.imageMade = keep;
  } else if (touched.body) {
    out.made = keep;
  }
  return out;
}
