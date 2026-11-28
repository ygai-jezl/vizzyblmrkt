/**
 * The reasons a person can give with a vote, as one shared list of keys and plain labels (the
 * plan for steps 4 and 5, section 3.11): after a thumbs down on an image, "What's off?", and after
 * a thumbs up, "Say what works". The key is kept on the image's row (`brandVoteReason`) and
 * counted per scope (`disliked.<key>` and `liked.<key>`); the label is what people see. Step 7
 * adds the reasons for posts and drafts here.
 *
 * A key is never renamed or removed once stored: a new reason adds a key. Keys are lower case
 * words joined by underscores, so they sit in a counter's field path as they are. Pure and client
 * safe.
 */

export interface VoteReason {
  key: string;
  label: string;
}

export const VOTE_REASONS = {
  image: {
    down: [
      { key: "colours", label: "Wrong colours" },
      { key: "mood", label: "Wrong mood or style" },
      { key: "subject", label: "Wrong subject" },
      { key: "fake", label: "Looks fake" },
      { key: "details", label: "Text or details wrong" },
      { key: "not_us", label: "Not us" },
      { key: "other", label: "Something else" },
    ],
    up: [
      { key: "colours", label: "Colours" },
      { key: "mood", label: "Mood or style" },
      { key: "subject", label: "Subject" },
      { key: "layout", label: "Layout" },
      { key: "other", label: "Something else" },
    ],
  },
} as const satisfies Record<string, Record<"down" | "up", readonly VoteReason[]>>;

export type VoteKind = keyof typeof VOTE_REASONS;
export type VoteDirection = "down" | "up";

/** A reason's key for an image vote, in either direction. */
export type ImageVoteReason =
  | (typeof VOTE_REASONS.image.down)[number]["key"]
  | (typeof VOTE_REASONS.image.up)[number]["key"];

/** Every key an image vote can keep, both directions, each once. */
export const IMAGE_VOTE_REASON_KEYS = [
  ...new Set([...VOTE_REASONS.image.down, ...VOTE_REASONS.image.up].map((r) => r.key)),
] as [ImageVoteReason, ...ImageVoteReason[]];

/** The most characters a vote's note may hold. */
export const VOTE_NOTE_CHARS = 200;

/** Whether a key is a reason for this kind of vote, in this direction. */
export function isVoteReason(kind: VoteKind, direction: VoteDirection, key: string): boolean {
  return VOTE_REASONS[kind][direction].some((r) => r.key === key);
}

/** The label people see for a reason; null when the key isn't one for that direction. */
export function voteReasonLabel(kind: VoteKind, direction: VoteDirection, key: string): string | null {
  return VOTE_REASONS[kind][direction].find((r) => r.key === key)?.label ?? null;
}
