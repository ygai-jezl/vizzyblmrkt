import { canonicalStyleId, imageStyleById } from "@/lib/content/imageStyle/catalogue";
import type { LookRead } from "@/lib/types/loopDay";
import { VOTE_REASONS, voteReasonLabel, type VoteDirection } from "./reasons";
import { cantCheck, shortDay, verdictWords } from "./verdictWords";

/**
 * The words of what image style learned, on every screen of step 4 (the plan for steps 4 and 5,
 * section 6): Brand › Image style's What it learned card (screen 1), the post image panel (1b),
 * the image details (2), Review's Go back card (3) and the learning setting (5). Pure and client
 * safe, so the server builds a view with them and the browser says the done lines after a click.
 * Every line is checked against the writing rules in learnedWords.test.ts.
 */

/** The brand look's scope, as src/lib/loops/read.ts names it (a test keeps the two the same). */
export const BRAND_LOOK_SCOPE = "image_style.brand";

/** The likes a style's first look needs (LOOP_RULES.firstLookLikes). */
export const FIRST_LOOK_LIKES = 3;
/** The votes a look needs before its first check (the verdict's first look). */
export const FIRST_CHECK_VOTES = 10;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Natural photo", or "Your brand's look". */
export function lookName(scope: string): string {
  if (scope === BRAND_LOOK_SCOPE) return "Your brand's look";
  return imageStyleById(canonicalStyleId(scope.slice("image_style.".length)))?.label ?? "This style";
}

/** A style's name inside a sentence: "Natural photo", or "your brand's" for the brand look. */
export function lookLabelIn(scope: string): string {
  return scope === BRAND_LOOK_SCOPE ? "your brand's" : lookName(scope);
}

/** Where a look came from, as its version row keeps it (evidenceCounts). */
export interface EvidenceCounts {
  liked: number;
  disliked: number;
  newestAt: string | null;
  /** Of the liked, the photos a person uploaded. */
  uploaded?: number;
  downReasons?: Record<string, number>;
}

/** The thumbs down reason given most, with its count; ties go to the first in the list. */
export function topReason(reasons: Record<string, number> | undefined, direction: VoteDirection = "down"): { label: string; n: number } | null {
  let best: { label: string; n: number } | null = null;
  for (const r of VOTE_REASONS.image[direction]) {
    const n = reasons?.[r.key] ?? 0;
    if (n > 0 && (!best || n > best.n)) best = { label: r.label, n };
  }
  return best;
}

const uploadsOnly = (e: EvidenceCounts) => e.disliked === 0 && e.liked > 0 && (e.uploaded ?? 0) >= e.liked;

/** "3 images you liked and 2 you didn't", or "4 photos you uploaded". */
export function evidenceWords(e: EvidenceCounts): string {
  if (uploadsOnly(e)) return `${plural(e.liked, "photo", "photos")} you uploaded`;
  const liked = `${plural(e.liked, "image", "images")} you liked`;
  return e.disliked > 0 ? `${liked} and ${e.disliked} you didn't` : liked;
}

/** "From 3 images you liked and 2 you didn't (Wrong mood or style 2), newest 14 Jan". */
export function fromLine(e: EvidenceCounts | null | undefined): string | null {
  if (!e || e.liked + e.disliked === 0) return null;
  const top = topReason(e.downReasons);
  const day = shortDay(e.newestAt);
  return `From ${evidenceWords(e)}${top ? ` (${top.label} ${top.n})` : ""}${day ? `, newest ${day}` : ""}`;
}

/** "Version 2's look came from 18 images you liked and 7 you didn't, newest 8 Dec", for a look Undo or Go back put back. */
export function restoredFromLine(v: number, e: EvidenceCounts | null | undefined, seeded: boolean): string | null {
  if (seeded) return `Version ${v}'s look was carried over from before YouGrow kept versions`;
  if (!e || e.liked + e.disliked === 0) return null;
  const day = shortDay(e.newestAt);
  return `Version ${v}'s look came from ${evidenceWords(e)}${day ? `, newest ${day}` : ""}`;
}

/** "Made 56 with it. You liked 9 of the 14 you voted on." */
export function countsLine(c: { made: number; voted: number; liked: number }): string {
  if (c.made <= 0 && c.voted <= 0) return "Made 0 with it so far.";
  const made = `Made ${c.made} with it.`;
  return c.voted > 0 ? `${made} You liked ${c.liked} of the ${c.voted} you voted on.` : made;
}

/** A scope with no look of its own: how far it is to its first. */
export function pendingLine(input: { brand: boolean; have: number; brandLook: boolean }): string {
  const have = Math.min(input.have, FIRST_LOOK_LIKES);
  if (input.brand) return `${have} of the ${FIRST_LOOK_LIKES} likes or uploads it needs.`;
  return `${have} of the ${FIRST_LOOK_LIKES} likes it needs. ${input.brandLook ? "Uses your brand's look meanwhile." : "Uses the presets meanwhile."}`;
}

/** "Used for Product still life until it learns its own." on the brand look's row. */
export function usedForLine(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  return `Used for ${listOf(names)} until ${names.length === 1 ? "it learns its own" : "each learns its own"}.`;
}

/** "Natural photo", "Natural photo and Illustration", "A, B and C". */
export function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** A version row as the words need it. */
export interface VersionFacts {
  v: number;
  createdBy: string;
  setBy?: string | null;
  createdAt: string;
  hasLook: boolean;
  evidenceCounts?: EvidenceCounts | null;
  /** Who wrote it, on rows a person wrote: "you" or "a teammate". */
  who?: string;
}

/** The version a person's Undo or Go back put back: the one before the version it left. */
export const restoredOf = (row: Pick<VersionFacts, "v" | "createdBy">): number | null =>
  row.createdBy === "undo" || row.createdBy === "revert" ? Math.max(0, row.v - 2) : null;

/**
 * A row's status, under its name: "Learned 14 Jan", "Version 3, learned 18 Jan", "Set by you on
 * 30 May", "Version 5, back to version 3's look on 26 Apr", "Learned 14 Jan, back in use on 30 May".
 * `restored` is the version a restoring row put back, when it is version 1 learned.
 */
export function statusLine(row: VersionFacts, opts: { restoredFirst?: VersionFacts | null; keptAt?: string | null; brand: boolean } = { brand: false }): string {
  const day = shortDay(row.createdAt) ?? "";
  const kept = opts.keptAt ? `, kept on ${shortDay(opts.keptAt)}` : "";
  if (row.createdBy === "forget") return `Forgotten on ${day}`;
  if (!row.hasLook) {
    if (opts.brand) return "No look yet";
    return row.v > 0 ? "No look of its own again" : "No look of its own yet";
  }
  if (row.setBy === "person") return `Set by you on ${day}`;
  const restored = restoredOf(row);
  if (restored !== null) {
    const first = opts.restoredFirst;
    if (restored === 1 && first && first.setBy === "learned") return `Learned ${shortDay(first.createdAt)}, back in use on ${day}${kept}`;
    return `Version ${row.v}, back to version ${restored}'s look on ${day}${kept}`;
  }
  if (row.setBy === "seeded" || row.createdBy === "seed") return `Carried over on ${day}${kept}`;
  return row.v === 1 ? `Learned ${day}${kept}` : `Version ${row.v}, learned ${day}${kept}`;
}

/**
 * One version in History, newest first: what made it, then "In use." or, for a replaced one, the
 * read that let it change (3.8). A version carried over from before versions can't be checked.
 */
export function historyLine(row: VersionFacts, opts: { inUse: boolean; read?: LookRead | null }): string {
  const who = row.who ?? "a teammate";
  const restored = restoredOf(row);
  let what: string;
  if (row.createdBy === "forget") what = `forgotten by ${who}`;
  else if (restored !== null) what = restored === 0 ? `undone by ${who}` : `back to version ${restored}'s look by ${who}${row.createdBy === "revert" ? ", from Review" : ""}`;
  else if (row.setBy === "person") what = `set by ${who}`;
  else if (row.setBy === "seeded" || row.createdBy === "seed") what = "carried over from before YouGrow kept versions";
  else what = row.evidenceCounts && row.evidenceCounts.liked + row.evidenceCounts.disliked > 0 ? `learned from ${evidenceWords(row.evidenceCounts)}` : "learned from your votes";
  const head = `Version ${row.v}, ${shortDay(row.createdAt) ?? ""}, ${what}.`;
  if (opts.inUse) return `${head} In use.`;
  if (opts.read) return `${head} ${verdictWords(opts.read, { form: "history" })}`;
  if (row.setBy === "seeded" || row.createdBy === "seed") return `${head} Can't be checked: nothing came before it.`;
  return head;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/**
 * A look that holds until the next change can be checked against it: "Keeping this look for 1 more
 * vote, so YouGrow can check the next change against it. About June at your pace." The month comes
 * from the votes counted since the look began; with none yet it is left out.
 */
export function holdLine(input: { counted: number; adoptedAt: string; now: Date }): string | null {
  const left = FIRST_CHECK_VOTES - input.counted;
  if (left <= 0) return null;
  const head = `Keeping this look for ${plural(left, "more vote", "more votes")}, so YouGrow can check the next change against it.`;
  const began = Date.parse(input.adoptedAt);
  const elapsed = input.now.getTime() - began;
  if (input.counted <= 0 || !Number.isFinite(began) || elapsed <= 0) return head;
  const at = new Date(input.now.getTime() + (elapsed / input.counted) * left);
  const month = MONTH_NAMES[at.getUTCMonth()]!;
  const year = at.getUTCFullYear() === input.now.getUTCFullYear() ? "" : ` ${at.getUTCFullYear()}`;
  return `${head} About ${month}${year} at your pace.`;
}

/** Before a look's first check: "Too few to check yet: 4 of the 10 votes it needs." */
export function tooFewYet(counted: number): string {
  return `Too few to check yet: ${Math.max(0, Math.min(counted, FIRST_CHECK_VOTES))} of the ${FIRST_CHECK_VOTES} votes it needs.`;
}

/** How a check line looks: liked more, worse, or still waiting. */
export type CheckTone = "good" | "bad" | "wait";

/**
 * The row's check line from the newest read of the look in use, or null when it shows none: a
 * style's first look that can't be checked keeps that line in History and in Vizzy's answer
 * (departure 8). `ask` adds "Go back to the earlier look?" to a worse read (the card's own notice).
 */
export function checkLine(read: LookRead | null, opts: { first: boolean; counted: number; since: string | null; ask?: boolean }): { text: string; tone: CheckTone } | null {
  if (!read) return opts.first ? null : { text: tooFewYet(opts.counted), tone: "wait" };
  if (cantCheck(read)) return opts.first ? null : { text: verdictWords(read, { since: opts.since }), tone: "wait" };
  const tone: CheckTone = read.call === "better" ? "good" : read.call === "worse" ? "bad" : "wait";
  return { text: verdictWords(read, { since: opts.since, ask: opts.ask && read.call === "worse" }), tone };
}

/** A style's first look's can't check line, for History and Vizzy. */
export function firstLookCantCheck(read: LookRead | null): string | null {
  return read && cantCheck(read) ? verdictWords(read, { first: true }) : null;
}

/** On a row whose Go back card waits in Review. */
export const goBackWaiting = (to: number): string => (to > 0 ? `Go back to version ${to}? It's waiting in Review.` : "Go back to no look of its own? It's waiting in Review.");
export const NOT_LEARNING_WHILE_OPEN = "Not learning while this is open";
export const ALWAYS_USED = "Always used. YouGrow keeps counting your votes but won't change it. Undo goes back to the learned look.";

// ----- The card's header, notes and footer -----

export const CARD_LEAD = "What YouGrow learned from your votes, for each painted style you use.";
export const EMPTY_CARD = "Mark images On-brand or Off-brand with the thumbs under each one. After 3 On-brand in a style, YouGrow learns its look.";
export const NOT_SET_UP = "Image learning isn't set up on this copy of YouGrow yet.";
export const COULDNT_LEARN = "Couldn't learn lately; trying again daily.";
export const SUGGESTIONS_PAUSED = "Go back suggestions are paused: most in the last 4 weeks went unanswered.";
export const MEMBER_LINE = "Your votes teach it. Only admins can undo, edit or forget a look.";
export const pausedNote = (at: string): string => `Paused on ${shortDay(at)}. What it learned is still used; nothing new is learned until you resume.`;
export const pausedChip = (at: string): string => `Paused on ${shortDay(at)}`;

export const FOOT_HOLDBACK = "About 1 image in 20 is made without what it learned, so YouGrow can check that learning helps. Looks you set or keep are always used.";
export const FOOT_SLOW = "With a few votes a month, checks take months. Until then what it learned is used, and you can undo it.";
export const FOOT_SEASON = "Checks are not adjusted for season.";
export const FOOT_DRAWN = "Headline card, Data story and the other drawn styles keep their layout and don't learn.";
export const FOOT_SETTING = "Settings › General:";
export const HELP_CHECK = "Help check that learning works";
export const HOW_THIS_WORKS = "How this works";

/** The edit box's helper (state l). */
export const EDIT_HELPER = "The look's words. Leave out links, email addresses, handles and phone numbers: a look with one can't be saved.";

// ----- Done lines, after a click -----

export const FORGET_DONE = "Forgotten. YouGrow won't learn this look again from the images that taught it.";
export const FORGET_UNDONE_DONE = "Forgotten. YouGrow won't learn the undone look again from the images that taught it.";
export const FORGET_OFFER = "Don't learn this again: Forget";
export const KEPT_DONE = "Kept. YouGrow only asks again if a later check reads worse.";

/** "Back to version 3 from 4 Feb." */
export const backToLine = (v: number, at: string | null | undefined): string => {
  const day = shortDay(at);
  return `Back to version ${v}${day ? ` from ${day}` : ""}.`;
};

/** What Undo says it did, on the card (or, `panel`, in the post image panel). */
export function undoDoneLine(input: {
  scope: string;
  restored: number;
  restoredAt?: string | null;
  /** The look undone was set by a person. */
  wasPerson: boolean;
  /** The brand look has words now, so a style with none uses it. */
  brandLook: boolean;
  /** The styles that use the brand look meanwhile, for the brand look's own Undo. */
  usingBrand?: readonly string[];
  panel?: boolean;
}): string {
  const brand = input.scope === BRAND_LOOK_SCOPE;
  if (input.restored <= 0) {
    if (brand) {
      const using = input.usingBrand ?? [];
      return using.length
        ? `Undone. Your brand's look is empty again, so ${listOf(using)} ${using.length === 1 ? "uses" : "use"} the presets.`
        : "Undone. Your brand's look is empty again, so new images use the presets.";
    }
    const name = lookName(input.scope);
    const fallback = input.brandLook ? "your brand's look" : "the presets";
    return input.panel ? `Undone. ${name} uses ${fallback} again.` : `Undone. ${name} has no look of its own again, so it uses ${fallback}.`;
  }
  if (input.wasPerson) {
    const day = shortDay(input.restoredAt);
    return `Back to the look learned${day ? ` on ${day}` : ""}. YouGrow learns from your votes again.`;
  }
  return backToLine(input.restored, input.restoredAt);
}

/** Forget's confirm (state h), with the real counts. */
export function forgetConfirm(input: { scope: string; liked: number; disliked: number; uploaded?: number; brandOverlap: number }): { title: string; body: string; also: string | null } {
  const brand = input.scope === BRAND_LOOK_SCOPE;
  const e: EvidenceCounts = { liked: input.liked, disliked: input.disliked, newestAt: null, uploaded: input.uploaded };
  const taught = input.liked + input.disliked > 0 ? ` from the ${evidenceWords(e)} that taught it` : " from the images that taught it";
  const stay = brand && uploadsOnly(e) ? "Your photos stay." : "Your votes stay.";
  return {
    title: brand ? "Forget your brand's look?" : `Forget the ${lookName(input.scope)} look?`,
    body: `YouGrow stops using it, clears its words, and won't learn again${taught}. ${stay} This can't be undone.`,
    also: !brand && input.brandOverlap > 0 ? `Also forget your brand's look, which learned from ${input.brandOverlap} of the same images` : null,
  };
}

/** The confirm for "Don't learn this again: Forget", after an Undo: the undone look goes, the look in use stays. */
export function forgetUndoneConfirm(scope: string): { title: string; body: string; also: null } {
  return {
    title: scope === BRAND_LOOK_SCOPE ? "Forget your brand's undone look?" : `Forget the undone ${lookName(scope)} look?`,
    body: "YouGrow clears its words and won't learn it again from the images that taught it. The look in use stays. This can't be undone.",
    also: null,
  };
}

/** The Reset confirm on the Image style card, with versions on (state k). */
export const RESET_CONFIRM = "Reset? Your style choices go back to the presets. What YouGrow learned stays; use Forget on What it learned to drop a look.";

// ----- The post image panel and the image details (screens 1b and 2) -----

/** "New look for Natural photo from your likes on 14 Jan." */
export const newLookNotice = (scope: string, at: string): string => `New look for ${lookLabelIn(scope)} from your likes on ${shortDay(at)}.`;
export const STANDING_LINE = "About 1 in 20 images is made without it, so YouGrow can check it helps.";
export const HELD_BACK_AFTER_VOTE = "This one was made without what it learned.";

/** "How this was made", from an image's stamp (screen 2); null when there is nothing to say. */
export function madeLine(made: { arm?: string; scope?: string; v?: number; sources?: readonly string[]; unstamped?: string } | null | undefined): string | null {
  if (!made) return "Made before YouGrow kept versions.";
  if (made.unstamped) return made.unstamped === "image_versions_off" ? "Made before YouGrow kept versions." : null;
  if (made.arm === "holdback") return "Made without what it learned, as about 1 in 20 images are.";
  if (made.sources?.includes("person_off")) return "Made with Use learned brand style off.";
  if (made.sources?.includes("legacy")) return "Made before YouGrow kept versions.";
  if (made.arm === "learned" && made.scope && typeof made.v === "number" && made.v > 0) {
    return made.scope === BRAND_LOOK_SCOPE ? `Made with your brand's look, version ${made.v}` : `Made with the ${lookName(made.scope)} look, version ${made.v}`;
  }
  return null;
}
export const HOW_THIS_WAS_MADE = "How this was made";

// ----- The why behind a vote (3.11) -----

export const WHY_WORDS = {
  down: { title: "What's off?", link: "Say what's off", saved: "What's off:" },
  up: { title: "What works?", link: "Say what works", saved: "What works:" },
  noteLabel: "Anything to add? (optional)",
  done: "Done",
} as const;

/** "12 of 200", under the note. */
export const noteCount = (n: number, max: number): string => `${n} of ${max}`;

/** "Thanks. The next Natural photo look takes this into account." */
export function reasonDoneLine(scope: string | null): string {
  if (!scope || scope === BRAND_LOOK_SCOPE) return "Thanks. Your brand's next look takes this into account.";
  return `Thanks. The next ${lookName(scope)} look takes this into account.`;
}

/** A saved reason's label, for the row and the details. */
export const reasonLabelOf = (direction: VoteDirection, key: string | null | undefined): string | null => (key ? voteReasonLabel("image", direction, key) : null);

// ----- The learning setting (screen 5, step 4's words) -----

export const LEARNING_SETTING = {
  title: "Learning",
  toggle: HELP_CHECK,
  words: "About 1 in 20 images is made without what YouGrow learned, so YouGrow can check that learning helps. Turn off to always use what it learned.",
  member: "Only admins can change it.",
} as const;
export const learningOffLine = (at: string): string => `Off since ${shortDay(at)}. Every image is made with what YouGrow learned.`;

// ----- The help page's examples (screen 4) -----

/**
 * What a check can say, as the help page shows it: each example is the words verdict() and
 * verdictWords give for those counts (learnedWords.test.ts makes each one from the real verdict).
 */
export const CHECK_EXAMPLES: ReadonlyArray<{ says: string; means: string }> = [
  { says: "Liked more often: 34 of 40 against 14 of 40 before.", means: "Better: the new look is liked more, by more than chance explains." },
  { says: "About the same: liked 60 of 120 against 60 of 120 before.", means: "Same: no real difference either way." },
  {
    says: "Liked less often since 9 Mar: 12 of 40 against 30 of 40 before. Go back to the earlier look?",
    means: "Worse: Review asks if you want the earlier look back. Nothing goes back on its own.",
  },
  {
    says: "Your images were remade more since 2 Apr: 20 of 40 against 4 of 40 before. Go back to the earlier look?",
    means: "Worse another way: you made images again far more often.",
  },
  {
    says: "Too few to tell yet. With 8 of 20 liked before, it would take about 19 of 20 to show. Next check at 40 votes.",
    means: "Too few: only a very big change could show this early.",
  },
  { says: "This first look can't be checked: only 5 votes came before it.", means: "Can't check: there was too little before it to compare with." },
];
