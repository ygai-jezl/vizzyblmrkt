import type { ResourcePurpose } from "@/lib/plans/resources";
import type { MeaningKey } from "@/lib/metrics/meanings";
import type { CanvasKindName } from "@/lib/canvas/names";
import type { DataSignalRule } from "@/lib/types/dataSignal";
import type { LoopSwitch } from "./switches";

/**
 * The learning registry: one line for every place YouGrow makes a choice for a brand, saying how
 * that choice learns from people or why it doesn't (ADR-0017, the Honest Loop: Declare, Stamp,
 * Count, Learn, Check). This file is the Declare step.
 *
 * Every line states what is true today:
 * - own(type, why): it already learns from people, in that ontology type's own store;
 * - gap(why, revisit): it should learn and doesn't yet, with a date to look again;
 * - none(why): it should never learn;
 * - learns(...) and fleetOnly(...): it learns through the loops. No line does yet.
 *
 * A new AI purpose, canvas, connector rule or rule decision fails npm run typecheck until it has
 * its line here. src/lib/loops/registry.test.ts checks the lines. Pure and client safe: it imports
 * types only.
 */

/**
 * Choices a rule makes for a brand with no model call, each with a plain label and the file that
 * makes it. A new rule that picks something for a brand adds a line here, then one in LOOPS.
 */
export const RULE_DECISIONS = {
  send_time: { label: "Send time", file: "src/lib/lifecycle/sendWindow.ts" },
  ab_split: { label: "Email test split", file: "src/lib/journey/allocation.ts" },
  ab_winner: { label: "Email test winner", file: "src/lib/journey/abTest.ts" },
  journey_next_step: { label: "Journey next step", file: "src/lib/lifecycle/planner.ts" },
  journey_shape: { label: "Journey template shape", file: "src/lib/lifecycle/architect.ts" },
  autopilot_cadence: { label: "Autopilot cadence", file: "src/lib/autopilot/tick.ts" },
  notes_rest: { label: "Notes rest", file: "src/lib/brandNotes/rest.ts" },
  next_up_order: { label: "Next up shortlist", file: "src/lib/nextUp/candidates.ts" },
  refresh_share: { label: "Refresh share of Next up", file: "src/lib/nextUp/pick.ts" },
  freshness_clock: { label: "Refresh clock", file: "src/lib/content/blog/freshness.ts" },
  refresh_due: { label: "Refresh due", file: "src/lib/content/blog/freshnessWatch.ts" },
  found_live: { label: "Approve when found live", file: "src/lib/content/blog/foundLive.ts" },
  competitor_coverage: { label: "Competitor coverage flags", file: "src/lib/competitors/coverage.ts" },
  competitor_topics: { label: "Competitor topics to add", file: "src/lib/competitors/coverage.ts" },
  image_style_pick: { label: "Image style used", file: "src/lib/content/imageStyle/resolve.ts" },
  pattern_holdout: { label: "Post patterns holdout", file: "src/lib/distribute/feedback/patterns.ts" },
  waitlist_rank: { label: "Waitlist order", file: "src/lib/waitlist/scoring.ts" },
  spintax_variant: { label: "Recurring post variant", file: "src/lib/distribute/spintax.ts" },
  auto_plug: { label: "Auto plug comment", file: "src/lib/distribute/autoPlug.ts" },
} as const satisfies Record<string, { label: string; file: string }>;

export type RuleDecision = keyof typeof RULE_DECISIONS;

/** Every place YouGrow makes a choice for a brand. A new one fails npm run typecheck until LOOPS has its line. */
export type LoopKind =
  | ResourcePurpose // every model call already names one (src/lib/plans/resources.ts)
  | `canvas.${CanvasKindName}` // every canvas Vizzy fills (src/lib/canvas/names.ts)
  | DataSignalRule // every connector rule (src/lib/types/dataSignal.ts)
  | RuleDecision; // every other rule

/**
 * The ontology types whose stores already hold what people taught YouGrow, each with where the
 * learning sits. An own(...) line names one of these; the registry test checks each is a built
 * type in src/lib/ontology/registry.ts.
 */
export const LEARNED_STORES = {
  learned: "The Learned list keeps what the team kept, skipped and moved while planning, with their reasons.",
  post_learning: "Post patterns and the best posts, worked out from how the brand's LinkedIn and X posts did.",
  vizzy_memory: "Memory Bank keeps what Vizzy learned about how each team member edits, per brand and member.",
  brand_kit: "The brand record keeps the image look learned from thumbs and ratings, per image style.",
  brand_map: "The brand map keeps the names, subjects, groups, situations and topics a person dismissed, with its list of dismissed suggestions holding the newest 300.",
  brand_question: "Each question a person dismissed stays on the brand map marked dismissed.",
  article_review: "An article's review keeps the fingerprints of the last 50 changes a person dismissed on it.",
  content_plan: "An article's brief keeps up to 50 notes a person took out of it.",
  broadcast: "Each launch email keeps its open and click rates once its report is read.",
  refresh_record: "Each refresh record keeps its clock, what a person decided and the clicks 28 days on.",
} as const satisfies Record<string, string>;

export type LearnedStore = keyof typeof LEARNED_STORES;

/** How a loop learns. A new learner is a platform change, never one per feature. */
export type Learner = "edits" | "votes";

/** A day as YYYY-MM-DD. */
export type Day = `${number}-${number}-${number}`;

export interface Loop {
  /** Listed "false" in apphosting.yaml and read only in src/lib/loops/switches.ts. */
  switch: LoopSwitch;
  learner: Learner;
  /** Where it learns (channels or style ids), each 40 characters at most. */
  scopes: readonly string[];
  /** The fast number judged per brand; its Meaning.better gives the direction. */
  check: MeaningKey;
  /** The number that must not get worse; never the same Meaning.family as check. */
  guard: MeaningKey;
  /** The smallest change worth acting on, fixed before looking. */
  band: number;
  /** suggest_only: money, legal text, sends to people or capital, which never change without a person. */
  mode: "suggest" | "suggest_only";
  /** Slow outcomes, nearest first, judged across brands only; never named after one vendor. */
  results?: readonly MeaningKey[];
  /** Kinds that learn one thing share it, such as every image kind learning one look. */
  pool?: string;
}

export type Decision =
  | { loop: Loop }
  | ({ fleet: string } & Pick<Loop, "check" | "guard" | "band" | "results">)
  | { own: LearnedStore; why: string }
  | { none: string }
  | { gap: string; revisit: Day };

export type DecisionKind = "learns" | "fleet" | "own" | "none" | "gap";

/** Which of the five a line says. */
export function decisionKind(d: Decision): DecisionKind {
  if ("loop" in d) return "learns";
  if ("fleet" in d) return "fleet";
  if ("own" in d) return "own";
  if ("none" in d) return "none";
  return "gap";
}

/** What each learner checks itself against, so a learns(...) line stays one line. */
export const BY_LEARNER = {
  edits: { check: "editShare", guard: "unusedShare", band: 0.1, mode: "suggest" },
  votes: { check: "likedShare", guard: "remadeShare", band: 0.15, mode: "suggest" },
} as const satisfies Record<Learner, Pick<Loop, "check" | "guard" | "band" | "mode">>;

/** Learns for each brand through the one writer, behind its own switch. */
export const learns = (sw: LoopSwitch, learner: Learner, scopes: readonly string[], more: Partial<Omit<Loop, "switch" | "learner" | "scopes">> = {}): { loop: Loop } => ({
  loop: { switch: sw, learner, scopes, ...BY_LEARNER[learner], ...more },
});
/** Stamped and counted for every brand, and improved only by a pull request the owner merges. */
export const fleetOnly = (why: string, how: Pick<Loop, "check" | "guard" | "band" | "results">) => ({ fleet: why, ...how });
/** Learned from people before the loops, in its own store: shown, not checked. */
export const own = (type: LearnedStore, why: string) => ({ own: type, why });
/** Never learns, and why. */
export const none = (why: string) => ({ none: why });
/** Should learn and doesn't yet: why, and a date at most LOOP_RULES.revisitMaxMonths ahead to look again. */
export const gap = (why: string, revisit: Day) => ({ gap: why, revisit });

const IMAGES_BY = "2027-01-31";
const POSTS_BY = "2027-03-31";
const LATER = "2027-05-01";

export const LOOPS = {
  // ----- AI purposes (src/lib/plans/resources.ts), in the order the meter lists them -----
  brand_map_research: own("brand_map", "A name, subject or group your team dismissed on the brand map is kept there and not proposed again."),
  situations: own("brand_map", "A buying situation your team already has or dismissed is never proposed again by research."),
  situation_questions: own("brand_question", "A question your team dismissed on the brand map is never proposed or linked to a situation again."),
  blog_research: gap("Research can read the Learned list through the brand context, but nothing records which facts and sources your team kept or cut.", LATER),
  autopilot_research: gap("The autopilot's research is never compared with what your team kept in the article, so it cannot learn which sources fit.", LATER),
  blog_refresh: own("article_review", "A change your team dismissed on an article is kept with the last 50 on its review and not proposed for that article again."),
  competitor_site: none("Finding a competitor's sitemap has one right answer, and a person can type the address in when it is wrong."),
  trending: none("It reports what your industry is talking about this week, a fact that changes on its own rather than a taste to learn."),
  enrichment: none("Company details such as size and industry are facts found on the web, and a person corrects a wrong one directly."),
  blog_write: gap("An article keeps no AI original beside your edits, so the writer cannot learn how your team changes its drafts.", POSTS_BY),
  fact_check: none("A fact check tests each claim against its cited source, and the right answer does not depend on taste."),
  seen_notes: own("content_plan", "A note your team took out of an article is kept on its brief and never matched back into it."),
  architect: gap("Nothing records the pieces your team adds or deletes after a workflow is laid out, so the next layout cannot follow them.", LATER),
  content_write: own("post_learning", "LinkedIn and X posts learn from how your past posts did and, where turned on, from how each team member edits them, while posts for other channels learn nothing yet."),
  content_email: gap("Emails in a workflow keep no AI original, so the changes your team makes to them cannot be measured yet.", POSTS_BY),
  content_hub: gap("A hub piece keeps no AI original beside your edits, so the writer cannot see what your team changed.", POSTS_BY),
  content_brief: none("A brief is a short instruction a person can rewrite before writing starts, and the piece written from it is what gets judged."),
  content_angle: gap("An angle you turn down with Suggest another is passed only to the next try and never kept as a no.", LATER),
  edit_mode: own("vizzy_memory", "Vizzy remembers how each team member edits in Edit mode, and each of them can turn it off or make it forget."),
  ebook: gap("eBook chapters keep no AI original, so the changes your team makes to them are never compared or learned.", LATER),
  templates: none("It copies the shape of a piece your team picked into a reusable template, so the choice is already theirs."),
  brand_voice: none("The voice is drafted once from your website and then edited by a person, so no repeated choice exists to learn from."),
  brand_kit: none("Colours are read once from the logo or site and a person sets them, so nothing repeats to learn from."),
  brand_notes: none("It splits text a person pasted into separate notes, and that person keeps or drops each one straight away."),
  email_layout: gap("The blocks your team moves, adds or removes after a layout is made are not kept, so the next layout cannot follow them.", LATER),
  email_copy: own("broadcast", "Email assist reads the open and click rates of the launch's last five emails before it writes, though invite wave copy reads none."),
  journeys: gap("A journey draft is saved over by your team's edits, so what they changed is never kept or learned.", LATER),
  lifecycle_lines: gap("Each AI line is approved, swapped for the fallback or skipped, but those decisions never shape the next line.", LATER),
  competitor_analysis: none("It labels and summarises a competitor's own pages as they are, so there is no taste of yours in it to learn."),
  competitor_articles: none("It records what each competitor article says and asks, a fact about their page rather than a choice made for you."),
  next_up: own("learned", "Next up learns from the picks your team skips, kept with their reason on the Learned list."),
  judge: own("learned", "The sorting learns from the questions your team moves between trays, kept on the Learned list."),
  post_feedback: none("This is the learner that turns post results into writing rules, and it is judged by the posts those rules shape."),
  images: none("This is the image style learner itself, and it is judged by the images its learned look shapes."),
  vizzy_chat: none("Each chat reply answers what the person just asked, and anything Vizzy saves is judged as the kind of draft it is."),
  product_map: none("It reads what your product's code does today, a fact rather than a taste, and a person decides what goes in the catalog."),
  other: none("Not a choice: no code spends under this name today, and every new call should name its real purpose."),
  blog_hero: own("brand_kit", "Blog heroes made on the article follow the look learned from your thumbs and ratings, per image style, but a hero Vizzy makes during a chat skips it."),
  post_image: own("brand_kit", "Post images follow the look learned from your thumbs and ratings on brand images, per image style."),
  email_block_image: own("brand_kit", "Images inside emails follow the look learned from your thumbs and ratings on brand images."),
  email_hero: gap("Email hero images skip the look learned from your image votes, so a thumbs down never reaches them.", IMAGES_BY),
  ebook_image: own("brand_kit", "eBook images follow the look learned from your thumbs and ratings on brand images, per image style."),
  customize_image: none("It edits a photo your team supplied the way they asked, and a learned look would restage their real product."),
  carousel: gap("Carousel slides skip the look learned from your image votes, so your thumbs never shape them.", IMAGES_BY),
  get_from_google: none("A person asks for this lookup and Google returns its results, so YouGrow makes no choice here to learn."),
  autopilot: own("learned", "The autopilot drafts only Next up's picks, so a pick your team skips on the Learned list is never drafted."),

  // ----- Canvases Vizzy fills (src/lib/canvas/names.ts) -----
  "canvas.journey": gap("Vizzy's launch email copy gets changed on the canvas before it goes live, but its first draft is not kept, so those changes cannot be counted.", LATER),
  "canvas.lifecycle": gap("Whether a journey Vizzy drafted gets published, and how much a person changed first, is never counted, so the next draft cannot get better.", LATER),
  "canvas.invite_wave": none("A launch sends only a few invite waves, so neither their size nor their copy learns, and a person sets the size and presses Send."),
  "canvas.content_plan": none("The plan only gathers pieces, and each piece, such as an article or a post, says how it learns under its own kind of writing."),
  "canvas.email_style": none("A brand sets its email look once and a person saves it, so there is no stream of repeated choices to learn a taste from."),
  "canvas.journey_style": none("A journey's own email look is a single choice a person saves on that journey, so nothing repeats that could be learned."),
  "canvas.person_plan": none("Each plan is about one named person and staff approve it, so learning from it would carry that person's details into plans for others."),
  "canvas.brand_map": own("brand_map", "A change a person dismissed is kept on the brand map and Vizzy does not file it again, though a buying situation a person asks Vizzy for in chat comes back as a suggestion."),
  "canvas.image_style": gap("Vizzy suggests an image style without reading the thumbs on the brand's images, and a dismissed suggestion is deleted with no record.", IMAGES_BY),
  "canvas.person_fields": none("Each suggestion is a fact about one person that a teammate confirms or dismisses, so it is right or wrong rather than a taste."),
  "canvas.new_person": none("Vizzy copies details from the chat into the New person form, and a person checks the facts and records consent, so no taste is involved."),

  // ----- Connector rules (src/lib/types/dataSignal.ts) -----
  rising_search: gap("Planning or dismissing a rising search only pauses that search for 30 days, and never changes which searches count as rising for this brand.", LATER),
  losing_page: gap("Pages losing clicks are flagged by fixed cut offs, and what the team did with earlier flags, or whether a refresh won clicks back, never tunes them.", LATER),
  within_reach: gap("Questions just off Google's first page are offered by fixed positions, and whether an article then reached page one is never looked at.", LATER),

  // ----- Rule decisions (RULE_DECISIONS above) -----
  send_time: gap("Product journeys send in a weekday morning window unless a person changes it, waitlist journeys send at any time, and opens by hour never move either.", LATER),
  ab_split: none("The split between versions has to stay a fair, stable coin toss per person, or the test can no longer say which email did better."),
  ab_winner: gap("A person can pick the winning email after 50 sends, but on a launch moved to the new journey engine that pick never reaches the emails sent.", LATER),
  journey_next_step: none("The next step is the path a person drew on the journey, and the walk follows it rather than picking a branch of its own."),
  journey_shape: gap("The templates' email counts and the days between emails are fixed numbers, and how earlier journeys did never changes them.", LATER),
  autopilot_cadence: none("The brand chooses the weekday and how many articles a week, and the autopilot keeps to that pace rather than setting its own."),
  notes_rest: gap("A note the team keeps taking out of articles can go straight into the next one, because each removal is kept on that article alone and never makes the note rest.", LATER),
  next_up_order: own("learned", "Questions the team skipped in the last 30 days are left out of the shortlist, read from the Learned list."),
  refresh_share: gap("At most one of Next up's three picks is a refresh unless the brand sets another number, and whether refreshes or new articles won more clicks never moves it.", LATER),
  freshness_clock: own("refresh_record", "Each article gets a 20, 30 or 45 day clock in turn, the refresh records show which clock gains clicks, and a person accepts the clock it suggests."),
  refresh_due: gap("Marking an article checked restarts its clock, but which reasons make articles due early never changes with what your team marks checked.", LATER),
  found_live: none("An article a person put up on their own site counts as approved by them, which is a fact to record, not a taste to learn."),
  competitor_coverage: none("The flags are plain counts of articles by competitors and by the brand over 90 days, which anyone can check, so there is no taste in them."),
  competitor_topics: own("brand_map", "A topic a person dismissed from the brand map is marked dismissed and left out of what Next up suggests from competitor articles."),
  image_style_pick: gap("Until a brand picks a style, every image uses a fixed preset for its surface, and thumbs on past images never change which style is used.", IMAGES_BY),
  pattern_holdout: none("A fixed share of posts is written without the learned patterns so their effect can be measured, and that share must not drift with results."),
  waitlist_rank: none("The waitlist order is the rule promised to people who signed up, referrals first and then sign up time, so it must never shift on its own."),
  spintax_variant: gap("A recurring post picks one of its written variants at random each time, and how each variant did is never used to favour the better one.", POSTS_BY),
  auto_plug: none("The promo comment fires only at the threshold a person set and it posts in public, so it should do exactly what they set."),
} as const satisfies Record<LoopKind, Decision>;

/** Every number the loops use, each with its reason. Nothing reads them until the loops run. */
export const LOOP_RULES = {
  /** A rate leans toward the shipped default with the weight of 5 outputs, so a new brand starts at the default (as PRIOR_N0 does in reward.ts). */
  blendM: 5,
  /** A verdict is read only at these outputs per side, then every 40, because reading daily turns 5% false alarms into about 26%. */
  looks: [10, 20, 40],
  /** A scope's first 10 outputs never serve as a before window, so a cold start is never what a change is judged against. */
  warmUp: 10,
  /** About 1 decision in 20 per scope leaves out shared defaults and items adopted without a card, so the fleet can check that learning helps. */
  holdbackOneIn: 20,
  /** At most 6 learned rule items reach a prompt, so the prompt never grows without limit. */
  ruleItems: 6,
  /** Those rule items fit in 300 tokens, which bounds what learning adds to each call's cost. */
  ruleTokens: 300,
  /** At most 2 examples reach a prompt, so examples guide the writing without crowding out the brief. */
  examples: 2,
  /** Each example is cut to 120 words, enough to show a voice without copying a whole piece. */
  exampleWords: 120,
  /** The edits learner waits for 2 edit pairs on 2 different days, so one rushed afternoon teaches nothing. */
  editsFloor: { pairs: 2, days: 2 },
  /** A version adopted without a card holds for 20 outputs, so its guard window is always read before it can change again. */
  holdAutoAdopted: 20,
  /** At most 1 learning card per kind per brand a week, so learning never floods the people it learns from. */
  cardsPerWeek: 1,
  /** At most 3 learning cards are open per brand at once, for the same reason. */
  openCards: 3,
  /** A card left for 14 days expires and counts as ignored. */
  cardDays: 14,
  /** A declined card stays away for 30 days. */
  quietDays: 30,
  /** A thing YouGrow made that is still unused 14 days later counts as unused, the guard for the edits learner. */
  unusedAfterDays: 14,
  /** A kind and scope whose stage has not moved after 10 outputs counts as stalled in the weekly retro. */
  stallOutputs: 10,
  /** Or after 14 days with no move, whichever comes first, so a quiet brand still shows a stall. */
  stallDays: 14,
  /** Counts across brands are shown only for groups of 10 or more organisations, so no one brand can be picked out. */
  cellOrgs: 10,
  /** A gap's revisit date is at most 6 months ahead, so every gap is looked at again within two quarters. */
  revisitMaxMonths: 6,
} as const;
