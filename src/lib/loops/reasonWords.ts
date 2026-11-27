import type { CanvasKindName } from "@/lib/canvas/names";
import { purposeLabel } from "@/lib/plans/resources";
import type { DataSignalRule } from "@/lib/types/dataSignal";
import type { UnstampedReason } from "@/lib/types/loopStamp";
import type { LearnReason } from "./learnLog";
import { RULE_DECISIONS, UNMETERED_CALLS } from "./registry";

/**
 * Plain words for the learning registry's kinds and for why a learner didn't learn (learning loops
 * step 5, 4.7 of the plan for steps 4 and 5), for the Loops section in Settings. Every kind shows
 * by its label and every reason in words; the raw keys stay only in get_learning's data.
 * src/lib/loops/reasonWords.test.ts gives every kind and every reason its words and holds them to
 * the house style (no dashes as punctuation, none of the AI tells). Pure and client safe.
 */

/** Each canvas Vizzy fills, by what it is for a person: a canvas's own card title names one draft, so this names the kind. */
export const CANVAS_TITLES: Record<CanvasKindName, string> = {
  journey: "Launch email journey",
  lifecycle: "Product journey draft",
  invite_wave: "Invite wave",
  content_plan: "Content plan",
  email_style: "Email style suggestion",
  journey_style: "Journey email style",
  person_plan: "A plan for one person",
  brand_map: "Brand map suggestions",
  image_style: "Image style suggestion",
  person_fields: "Field changes for a person",
  new_person: "New person form",
};

/** Each connector rule by what it flags. */
export const SIGNAL_RULE_LABELS: Record<DataSignalRule, string> = {
  rising_search: "Rising searches",
  losing_page: "Pages losing clicks",
  within_reach: "Questions within reach",
};

/** The row the five image kinds count under, as one pool (src/lib/loops/stages.ts). */
const POOL_LABELS: Record<string, string> = { image_style: "Image style" };

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * A kind's plain label: a rule's or an unmetered call's own label, an AI purpose's label, a
 * canvas's or a connector rule's title, or the image pool's name. A key this copy doesn't know
 * reads "Another kind", never the key.
 */
export function kindLabel(kind: string): string {
  if (has(POOL_LABELS, kind)) return POOL_LABELS[kind]!;
  if (kind.startsWith("canvas.")) {
    const name = kind.slice("canvas.".length);
    return has(CANVAS_TITLES, name) ? CANVAS_TITLES[name as CanvasKindName] : "Another kind";
  }
  if (has(SIGNAL_RULE_LABELS, kind)) return SIGNAL_RULE_LABELS[kind as DataSignalRule];
  if (has(RULE_DECISIONS, kind)) return RULE_DECISIONS[kind as keyof typeof RULE_DECISIONS].label;
  if (has(UNMETERED_CALLS, kind)) return UNMETERED_CALLS[kind as keyof typeof UNMETERED_CALLS].label;
  const label = purposeLabel(kind);
  return label === kind ? "Another kind" : label;
}

/** Why a learner didn't learn: a label for a list, and the same words inside a sentence. */
const REASON_WORDS: Record<LearnReason, { label: string; inline: string }> = {
  switch: { label: "Turned off on this copy", inline: "turned off on this copy" },
  paused: { label: "Paused by the brand", inline: "paused by the brand" },
  floor: { label: "Not enough to learn from yet", inline: "not enough to learn from yet" },
  budget: { label: "Daily limit reached", inline: "the daily limit was reached" },
  full: { label: "No room for more", inline: "no room for more" },
  trust: { label: "Refused: a link, email or handle in it", inline: "a link, email or handle in what it would learn" },
  region: { label: "Brand's data is outside Vizzy's region", inline: "the brand's data is outside Vizzy's region" },
  plan: { label: "Not in the brand's plan", inline: "not in the brand's plan" },
  not_configured: { label: "Not set up on this copy", inline: "not set up on this copy" },
  error: { label: "The model failed or timed out", inline: "the model failed or timed out" },
  off_by_person: { label: "Turned off by a person", inline: "turned off by a person" },
};

/**
 * A learner's refusal reason (LEARN_REASONS in ./learnLog.ts) in plain words: as a label, or
 * inside a sentence. A key this copy doesn't know reads "Another reason".
 */
export function reasonWords(reason: string, form: "label" | "inline" = "label"): string {
  if (!has(REASON_WORDS, reason)) return form === "label" ? "Another reason" : "another reason";
  return REASON_WORDS[reason as LearnReason][form];
}

/** Why a save kept no stamp (UNSTAMPED_REASONS), and a lost stamp, inside a sentence. */
const UNSTAMPED_WORDS: Record<UnstampedReason | "stamp_lost", string> = {
  loops_off: "learning loops off",
  image_versions_off: "image versions off",
  own_image: "a person's own image",
  removes_image: "a save that only takes an image away",
  person_restored: "a person restored an earlier version",
  person_marked_checked: "a person marked it checked",
  dates_only: "a save of dates only",
  records_where: "a save of where it lives",
  person_wrote: "words a person wrote",
  records_off: "send records off",
  connected_data: "numbers a connected product sent",
  reads_only: "a route that only reads",
  starts_worker: "a route that starts a worker",
  nothing_made: "nothing new made",
  chat_reply: "a chat reply",
  learner: "a learner's own call",
  stamp_lost: "a stamp lost",
};

/** Why saves kept no stamp, in words: each UNSTAMPED_COUNTS key, a stamp refused at save included. */
export function unstampedWords(reason: string): string {
  if (has(UNSTAMPED_WORDS, reason)) return UNSTAMPED_WORDS[reason as UnstampedReason];
  if (reason.startsWith("token_")) return "a stamp refused at save";
  return "another reason";
}

/** A key from a closed list a person picked from (a decline's why, an industry), in words: "not_relevant" reads "Not relevant". */
export function keyWords(key: string): string {
  const words = key.replace(/[_.]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Another reason";
}
