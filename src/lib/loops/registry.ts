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
 * - own(store, why): it already learns from people, in that store, where the switches for that
 *   learning are on;
 * - gap(why, revisit): it should learn and doesn't yet, with a date to look again;
 * - none(why): it should never learn;
 * - learns(...): it learns for each brand through the loops, behind its own switch
 *   (src/lib/loops/switches.ts). The image kinds are the first, from step 4;
 * - fleetOnly(...): it is counted for every brand and improved by pull request. No line does yet.
 *
 * A new AI purpose, canvas or connector rule, or a new key in RULE_DECISIONS or UNMETERED_CALLS,
 * fails npm run typecheck until it has its line here. src/lib/loops/registry.test.ts checks the lines. Pure and client safe: it imports
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
  insight_pick: { label: "Insight an email features", file: "src/lib/lifecycle/recipientContext.ts" },
  autopilot_cadence: { label: "Autopilot cadence", file: "src/lib/autopilot/tick.ts" },
  notes_rest: { label: "Notes rest", file: "src/lib/brandNotes/rest.ts" },
  next_up_order: { label: "Next up shortlist", file: "src/lib/nextUp/candidates.ts" },
  refresh_share: { label: "Refresh share of Next up", file: "src/lib/nextUp/pick.ts" },
  repeat_match: { label: "Repeat match", file: "src/lib/nextUp/repeats.ts" },
  ai_answer_match: { label: "AI answers prompt matched", file: "src/lib/connectors/signals/aiAnswers.ts" },
  slot_merge: { label: "Questions merged into slots", file: "src/lib/contentStrategy/slots.ts" },
  roadmap_order: { label: "Content plan roadmap", file: "src/lib/contentStrategy/roadmap.ts" },
  freshness_clock: { label: "Refresh clock", file: "src/lib/content/blog/freshness.ts" },
  refresh_due: { label: "Refresh due", file: "src/lib/content/blog/freshnessWatch.ts" },
  found_live: { label: "Approve when found live", file: "src/lib/content/blog/foundLive.ts" },
  competitor_coverage: { label: "Competitor coverage flags", file: "src/lib/competitors/coverage.ts" },
  competitor_topics: { label: "Competitor topics to add", file: "src/lib/competitors/coverage.ts" },
  competitor_profile: { label: "What competitors write", file: "src/lib/competitors/profile.ts" },
  competitor_claim_match: { label: "Claims competitors now make", file: "src/lib/competitors/profile.ts" },
  strategy_check: { label: "Weekly strategy check", file: "src/lib/brandStrategy/checkRules.ts" },
  strategy_month: { label: "How the strategy went each month", file: "src/lib/brandStrategy/monthRules.ts" },
  strategy_suggest: { label: "The strategy's suggestion each month", file: "src/lib/brandStrategy/suggestRules.ts" },
  image_style_pick: { label: "Image style used", file: "src/lib/content/imageStyle/resolve.ts" },
  pattern_holdout: { label: "Post patterns holdout", file: "src/lib/distribute/feedback/patterns.ts" },
  waitlist_rank: { label: "Waitlist order", file: "src/lib/waitlist/scoring.ts" },
  spintax_variant: { label: "Recurring post variant", file: "src/lib/distribute/spintax.ts" },
  auto_plug: { label: "Auto plug comment", file: "src/lib/distribute/autoPlug.ts" },
  next_action_order: { label: "Your next action order", file: "src/lib/onboarding/homeOrder.ts" },
  sidebar_fit: { label: "Sidebar sections that wait", file: "src/lib/onboarding/sidebarFit.ts" },
  work_check_due: { label: "Work check due", file: "src/lib/work/service.ts" },
  work_ready: { label: "Ready to start", file: "src/lib/work/service.ts" },
  work_measure_kind: { label: "Suggested kind of win", file: "src/lib/work/measureKind.ts" },
  investor_quiet: { label: "Investor follow-ups", file: "src/lib/raise/pipeline/due.ts" },
  paste_columns: { label: "Pasted columns read as fields", file: "src/lib/crm/paste/columns.ts" },
} as const satisfies Record<string, { label: string; file: string }>;

export type RuleDecision = keyof typeof RULE_DECISIONS;

/**
 * Model calls that spend under no purpose and choose something for a brand, so no meter call names
 * them, each with a plain label and the file that makes the call. Typecheck cannot find a new one by
 * itself: a model call with no meter adds a line here, then one in LOOPS.
 * src/lib/agents/groundedMeter.test.ts finds every file that calls a Google model, through the
 * Gemini SDK or over REST, and fails on one that is not gemini.ts, Vizzy's agent runtime, a file
 * here or a file it names with its reason (the search vectors, which choose nothing).
 */
export const UNMETERED_CALLS = {
  waitlist_voice_chat: { label: "Waitlist voice chat", file: "src/lib/hooks/useLiveConversation.ts" },
  edit_memory: { label: "Memory Bank memories", file: "src/lib/agents/memoryBank.ts" },
  search_rerank: { label: "Search rerank", file: "src/lib/search/rerank.ts" },
} as const satisfies Record<string, { label: string; file: string }>;

export type UnmeteredCall = keyof typeof UNMETERED_CALLS;

/** Every place YouGrow makes a choice for a brand. A new one fails npm run typecheck until LOOPS has its line. */
export type LoopKind =
  | ResourcePurpose // every metered model call names one (src/lib/plans/resources.ts)
  | `canvas.${CanvasKindName}` // every canvas Vizzy fills (src/lib/canvas/names.ts)
  | DataSignalRule // every connector rule (src/lib/types/dataSignal.ts)
  | RuleDecision // every other rule
  | UnmeteredCall; // every model call with no meter that chooses something

/**
 * The ontology types whose stores already hold what people taught YouGrow, each with where the
 * learning sits. An own(...) line names one of these; the registry test checks each is a built
 * type in src/lib/ontology/registry.ts.
 */
export const LEARNED_STORES = {
  learned: "The Learned list keeps what the team kept, skipped and moved while planning, with their reasons.",
  post_learning: "Post patterns and the best posts, worked out from how the brand's LinkedIn and X posts did, and where turned on the workflow emails and hub pieces a person approved, kept as examples.",
  vizzy_memory: "Memory Bank keeps what Vizzy learned about how each team member edits, per brand and member.",
  brand_map: "The brand map keeps the names, subjects, groups, situations and topics a person dismissed, with its list of dismissed suggestions holding the newest 300.",
  brand_question: "Each question a person dismissed stays on the brand map marked dismissed.",
  article_review: "An article's review keeps the fingerprints of the last 50 changes a person dismissed on it.",
  content_plan: "An article's brief keeps up to 50 notes a person took out of it.",
  broadcast: "Each one off launch email keeps its open and click rates once its report is read.",
  refresh_record: "Each refresh record keeps its clock, what a person decided and the clicks 28 days on.",
  next_action_card: "The card's record keeps the newest 30 outcomes of its steps and each step's newest dismissal of the last 30 days, with the reason a person gave for it.",
  brand_strategy:
    "The brand strategy keeps the newest 50 names a person marked Not a competitor, and the monthly suggestions a person put off with Not now with their reasons, beside the stars, ticks, groups and edits people made.",
  lifecycle_journey: "A launch's journey on the lifecycle engine keeps each email test winner a person picked, with when and the versions it was picked from.",
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
/** Learned from people before the loops, in its own store, where the switches for that learning are on: shown, not checked. */
export const own = (type: LearnedStore, why: string) => ({ own: type, why });
/** Never learns, and why. */
export const none = (why: string) => ({ none: why });
/** Should learn and doesn't yet: why, and a date at most LOOP_RULES.revisitMaxMonths ahead to look again. */
export const gap = (why: string, revisit: Day) => ({ gap: why, revisit });

/**
 * Where the image kinds learn: one scope per painted style (each a learned_pattern_versions
 * channel), and the brand look, which a painted style with no look of its own uses. Drawn styles
 * never learn. registry.test.ts checks it against the catalogue's model styles.
 */
export const IMAGE_STYLE_SCOPES = [
  "image_style.illustration",
  "image_style.editorial_photo",
  "image_style.soft_3d",
  "image_style.paper_collage",
  "image_style.natural_photo",
  "image_style.product_still_life",
  "image_style.brand_character",
  "image_style.brand",
] as const;
export type ImageStyleScope = (typeof IMAGE_STYLE_SCOPES)[number];

const IMAGES_BY = "2027-01-31";
const POSTS_BY = "2027-03-31";
const LATER = "2027-05-01";

/**
 * A meaning named after one provider (ga4, cf, linkedin, google). A loop's slow outcome and a Work
 * measure's number must hold whatever source a brand connects, so neither names one.
 */
export const VENDOR = /^(?:ga4|cf|linkedin|google)[A-Z]/;

export const LOOPS = {
  // ----- AI purposes (src/lib/plans/resources.ts), in the order the meter lists them -----
  brand_map_research: own("brand_map", "A name, subject or group your team dismissed on the brand map is kept there and not proposed again."),
  situations: own("brand_map", "A buying situation your team already has or dismissed is never proposed again by research."),
  situation_questions: own("brand_question", "A question your team dismissed on the brand map is never proposed or linked to a situation again."),
  brand_strategy: gap("The brand strategy keeps each focus star a person kept or removed and each claim they edited, before and after, but nothing learns from them yet.", LATER),
  content_strategy: gap("The content plan keeps each pillar a person renamed and each slot they split or joined, but naming and grouping the pillars learns nothing from them yet.", LATER),
  competitor_find: own("brand_strategy", "Where the strategy is joined to Competitors, a name a person marked Not a competitor is kept on the brand strategy and the finder never suggests it again."),
  blog_research: gap("Research can read the Learned list through the brand context, but nothing records which facts and sources your team kept or cut.", LATER),
  autopilot_research: gap("The autopilot's research is never compared with what your team kept in the article, so it cannot learn which sources fit.", LATER),
  blog_refresh: own("article_review", "A change your team dismissed on an article is kept with the last 50 on its review and not proposed for that article again."),
  competitor_site: none("Finding a competitor's sitemap has one right answer, and a person can type the address in when it is wrong."),
  trending: none("It reports what your industry is talking about this week, a fact that changes on its own rather than a taste to learn."),
  enrichment: none("Company details such as size and industry are facts found on the web, and a person corrects a wrong one directly."),
  blog_write: gap("Where turned on, an article keeps its AI original and how your team changed it before approving it, but the writer learns nothing from those edits yet.", LATER),
  fact_check: none("A fact check tests each claim against its cited source, and the right answer does not depend on taste."),
  seen_notes: own("content_plan", "A note your team took out of an article is kept with the last 50 on its brief and not matched back into it."),
  architect: gap("Nothing records the pieces your team adds or deletes after a workflow is laid out, so the next layout cannot follow them.", LATER),
  content_write: own("post_learning", "Where those parts are turned on, LinkedIn and X posts learn from how your past posts did and from how each team member edits them, while posts for other channels learn nothing yet."),
  content_email: own("post_learning", "Where turned on, a workflow email follows the emails your team approved, kept as examples of the brand's own writing, though how your team edited each draft teaches it nothing yet."),
  content_hub: own("post_learning", "Where turned on, a newsletter or blog hub follows the hub pieces your team approved or put live, kept as examples, though an eBook hub reads none and edits to each draft teach it nothing yet."),
  content_brief: none("A brief is a short instruction a person can rewrite before writing starts, and the piece written from it is what gets judged."),
  content_angle: gap("An angle you turn down with Suggest another is passed only to the next try and never kept as a no.", LATER),
  edit_mode: own("vizzy_memory", "Where learning from edits is on for a brand, through its plan or, where this copy allows it, through Vizzy in Edit mode with its data where Vizzy runs, Vizzy remembers how each team member edits in Edit mode, and each of them can turn it off or make it forget."),
  ebook: gap("eBook chapters keep no AI original, so the changes your team makes to them are never compared or learned.", LATER),
  templates: none("It copies the shape of a piece your team picked into a reusable template, so the choice is already theirs."),
  brand_voice: none("The voice is drafted once from your website and then edited by a person, so no repeated choice exists to learn from."),
  brand_kit: none("The kit is read from a guidelines PDF, the logo or the site, and colour themes are only offered for a person to pick, so the brand sets it rather than YouGrow choosing again and again."),
  brand_notes: none("It splits text a person pasted into separate notes, and that person keeps or drops each one straight away."),
  email_layout: gap("The blocks your team moves, adds or removes after a layout is made are not kept, so the next layout cannot follow them.", LATER),
  email_copy: own("broadcast", "Email assist reads the open and click rates of the launch's last five one off emails with a report before it writes, though invite wave copy reads none."),
  journeys: gap("A journey draft is saved over by your team's edits, so what they changed is never kept or learned.", LATER),
  lifecycle_lines: gap("Each AI line is approved, swapped for the fallback or skipped, but those decisions never shape the next line.", LATER),
  translation: gap("A person's edits to a translation are kept as the version they approved, but the next translation learns nothing from them yet.", LATER),
  competitor_analysis: none("It labels and summarises a competitor's own pages as they are, so there is no taste of yours in it to learn."),
  competitor_articles: none("It records what each competitor article says and asks, a fact about their page rather than a choice made for you."),
  next_up: own("learned", "Next up learns from the picks your team skips, kept with their reason on the Learned list."),
  judge: own("learned", "Where learning from the Learned list is turned on, the sorting learns from the questions your team moves between trays."),
  post_feedback: none("This is the learner that turns post results into writing rules, and it is judged by the posts those rules shape."),
  images: none("This is the image style learner from before versions, and where versions are on its calls move to the loops' own learner."),
  loop_learn: none("The learners themselves, judged by the loops they feed."),
  vizzy_chat: gap(
    "Vizzy's Work task suggestions and drafts and the notes it suggests in chat keep what it proposed beside what the person did with each one, and with the learning loops on Work's answers are counted kept, edited or dismissed, but nothing learns from those choices yet.",
    LATER,
  ),
  product_map: none("It reads what your product's code does today, a fact rather than a taste, and a person decides what goes in the catalog."),
  onboarding: none("It turns what the founder said into the four answers and facts in their own words, and the founder keeps, changes or removes each one before anything is saved."),
  next_action: own("next_action_card", "A step your team dismissed stays off the card for 30 days, and the next card for the brand reads what was done, answered, dismissed with its reason or left untouched."),
  other: none("Not a choice: no code spends under this name today, and every new call should name its real purpose."),
  blog_hero: learns("IMAGE_STYLE_VERSIONS_ENABLED", "votes", IMAGE_STYLE_SCOPES, { pool: "image_style" }),
  post_image: learns("IMAGE_STYLE_VERSIONS_ENABLED", "votes", IMAGE_STYLE_SCOPES, { pool: "image_style" }),
  email_block_image: learns("IMAGE_STYLE_VERSIONS_ENABLED", "votes", IMAGE_STYLE_SCOPES, { pool: "image_style" }),
  email_hero: learns("IMAGE_STYLE_VERSIONS_ENABLED", "votes", IMAGE_STYLE_SCOPES, { pool: "image_style" }),
  ebook_image: learns("IMAGE_STYLE_VERSIONS_ENABLED", "votes", IMAGE_STYLE_SCOPES, { pool: "image_style" }),
  customize_image: none("It edits a photo your team supplied the way they asked, and a learned look would restage their real product."),
  carousel: none("Each carousel slide is a picture of the post's own words, so a learned photo look would fight the text it has to show."),
  get_from_google: none("A person asks for this lookup and Google returns its results, so YouGrow makes no choice here to learn."),
  autopilot: own("learned", "The autopilot drafts only Next up's picks, so a pick your team skipped in the last 30 days is not drafted."),
  onboarding_voice: none("Vizzy talks with one founder in the moment to cover four questions, and learning from what they said would carry it into calls with other brands."),

  // ----- Canvases Vizzy fills (src/lib/canvas/names.ts) -----
  "canvas.journey": gap("Vizzy's launch email copy gets changed on the canvas before it goes live, and with the agent record on whether a person changed it is kept, but not what they changed, so nothing learns from it yet.", LATER),
  "canvas.lifecycle": gap("With the agent record on, whether a journey Vizzy drafted gets published, and whether a person changed it first, is kept and counted, but not what they changed, so the next draft cannot get better yet.", LATER),
  "canvas.invite_wave": none("A launch sends only a few invite waves, so neither their size nor their copy learns, and a person sets the size and presses Send."),
  "canvas.content_plan": none("The plan only gathers pieces, and each piece, such as an article or a post, says how it learns under its own kind of writing."),
  "canvas.email_style": none("A brand sets its email look once and a person saves it, so there is no stream of repeated choices to learn a taste from."),
  "canvas.journey_style": none("A journey's own email look is a single choice a person saves on that journey, so nothing repeats that could be learned."),
  "canvas.person_plan": none("Each plan is about one named person and staff approve it, so learning from it would carry that person's details into plans for others."),
  "canvas.brand_map": own("brand_map", "A change a person dismissed is kept on the brand map and Vizzy does not file it again, though a buying situation a person asks Vizzy for in chat comes back as a suggestion."),
  "canvas.image_style": gap("Vizzy suggests an image style without reading the thumbs on the brand's images or the look each style learned, and with the agent record on a dismissed suggestion is kept as a record that nothing learns from yet.", IMAGES_BY),
  "canvas.person_fields": none("Each suggestion is a fact about one person that a teammate confirms or dismisses, so it is right or wrong rather than a taste."),
  "canvas.new_person": none("Vizzy copies details from the chat into the New person form, and a person checks the facts and records consent, so no taste is involved."),

  // ----- Connector rules (src/lib/types/dataSignal.ts) -----
  rising_search: gap("A rising search your team plans or dismisses in Review stays away for 30 days, and one proposed as a question on a large brand map never comes back, but neither changes which searches count as rising.", LATER),
  losing_page: gap("Pages losing clicks are flagged by fixed cut offs, and what the team did with earlier flags, or whether a refresh won clicks back, never tunes them.", LATER),
  within_reach: gap("Questions whose search averages position 5 to 20 on Google are offered by fixed cut offs, and whether an article then moved them up is never looked at.", LATER),

  // ----- Rule decisions (RULE_DECISIONS above) -----
  send_time: gap("Product journeys send in a weekday morning window unless a person changes it, waitlist journeys send at any time, and opens by hour never move either.", LATER),
  ab_split: none("The split between versions has to stay a fair, stable coin toss per person, or the test can no longer say which email did better."),
  ab_winner: own("lifecycle_journey", "Where turned on, the winner a person picks for an email test after 50 sends reaches the journey the launch sends from on either engine, so everyone who gets that email from then on gets the winner."),
  journey_next_step: none("The next step is the path a person drew on the journey, and the walk follows it rather than picking a branch of its own."),
  journey_shape: gap("The templates start from default email counts and days between emails that a person or Vizzy can change, and how earlier journeys did never moves those defaults.", LATER),
  insight_pick: gap("Each email features the product's highest weighted insight not used yet, and whether emails with that insight got clicks never changes the pick.", LATER),
  autopilot_cadence: none("The brand chooses the weekday and how many articles a week, and the autopilot keeps to that pace rather than setting its own."),
  notes_rest: gap("A note the team keeps taking out of articles can go straight into the next one, because each removal is kept on that article alone and never makes the note rest.", LATER),
  next_up_order: own("learned", "Questions the team skipped in the last 30 days are left out of the shortlist, read from the Learned list, and where turned on a subject counts by its size as well as its share answered."),
  repeat_match: own("learned", "A question your team wrote anyway, added to an article or unlinked is kept on the Learned list and not matched that way again, though the closeness cut offs never move."),
  ai_answer_match: gap("A question is shown the AI answers numbers of the monitored prompt with the same or most of the same words, by a fixed cut off, and the picks your team skips never change which prompt is matched.", LATER),
  slot_merge: gap("Questions close in meaning are merged into one article at a fixed closeness, and the closeness cut off never moves, though the slots your team splits or joins are kept on the plan.", LATER),
  roadmap_order: own("learned", "A pick your team skipped, on the roadmap or in Next up, is kept on the Learned list and left out of the next plan's roadmap for 30 days, though the funnel mix and the focus pillars never move by themselves."),
  refresh_share: gap("At most one of Next up's three picks is a refresh unless the brand sets another number, and whether refreshes or new articles won more clicks never moves it.", LATER),
  freshness_clock: own("refresh_record", "Each article gets a 20, 30 or 45 day clock in turn, and where article refresh is turned on, the refresh records show which clock gains clicks and a person accepts the clock it suggests."),
  refresh_due: gap("Marking an article checked restarts its clock, but which reasons make articles due early never changes with what your team marks checked.", LATER),
  found_live: none("An article a person put up on their own site counts as approved by them, which is a fact to record, not a taste to learn."),
  competitor_coverage: none("The flags compare competitor articles from the last 90 days with the questions the brand has answered, drafted or planned on each subject, plain counts anyone can check, so there is no taste in them."),
  competitor_topics: own("brand_map", "A topic a person dismissed from the brand map is marked dismissed and left out of what Next up suggests from competitor articles."),
  competitor_profile: none("Each profile counts a watched competitor's articles of the last 90 days by kind, stage, ask and buying situation, which anyone can check against the articles themselves."),
  competitor_claim_match: gap("A claim of yours that a competitor's articles start to make too is never spotted, because checking it honestly needs a meaning check per claim and a cut off that would raise false alarms.", LATER),
  strategy_check: gap("The weekly strategy check keeps each row your team acted on with Propose or dismissed, but how many new articles or names make a row never changes from them yet.", LATER),
  strategy_month: none("How it went adds up plain counts anyone can check, each from a source it names, and chooses nothing for the brand, so it has nothing to learn."),
  strategy_suggest: own("brand_strategy", "A suggestion your team put off with Not now stays away 60 days, or 90 for one about connecting a tool, and the reason they gave is kept with the strategy."),
  image_style_pick: gap("Where image versions are on, each painted style learns its own look from votes, but which style an image uses is still the brand's pick or a fixed preset for its surface, and votes never change it.", IMAGES_BY),
  pattern_holdout: none("A fixed share of posts is written without the learned patterns so their effect can be measured, and that share must not drift with results."),
  waitlist_rank: none("The waitlist order is the rule promised to people who signed up: referrals, any bonus for finishing the voice chat and a teammate's Move up, then sign up time, so it must never shift on its own."),
  spintax_variant: gap("A recurring post picks one of its written variants at random each time, and how each variant did is never used to favour the better one.", POSTS_BY),
  auto_plug: none("The promo comment fires only at the threshold a person set and it posts in public, so it should do exactly what they set."),
  next_action_order: gap("When Your next action has no card from Vizzy, Home lists the steps of the stage that fits the four answers by a fixed rule, and the outcomes the card now records never change that order.", "2027-02-26"),
  sidebar_fit: none("A section waits under Coming up only until the brand puts something in it or opens it early, and from then on it always shows, so the person's own choice is what is kept."),
  work_check_due: none("A person sets the date, the task to wait for or the measure; the rule only shows the check once it is due."),
  work_ready: gap("Which ready task to start first could learn from what people pick; Work records the picks now, and learns once the votes learner can read them.", LATER),
  work_measure_kind: gap("The kind people pick over the suggested one could teach the suggestion; Work keeps both now, and learns once the votes learner can read them.", LATER),
  investor_quiet: gap("A follow-up comes up after 14 quiet days or a past next step date, and the follow-ups your team dismisses never change that rule.", LATER),
  paste_columns: none("Each column is read by its header the same way for every brand, and the list shows how every column was read before an admin adds a row."),

  // ----- Model calls with no meter (UNMETERED_CALLS above) -----
  waitlist_voice_chat: none("The voice chat answers one person on a waitlist in the moment, and learning from what they said would carry it into chats with other people."),
  edit_memory: none("This is Memory Bank's own learner, which picks what to remember from each member's edits, and it is judged by the Edit mode changes and the LinkedIn and X drafts those memories shape."),
  search_rerank: none("The ranking model only reorders the same search results by how well each answers the words asked, so it holds no taste of yours to learn."),
} as const satisfies Record<LoopKind, Decision>;

/**
 * Every number the loops use, each with its reason. The verdict (src/lib/loops/verdict.ts) reads
 * some, its tests hold it to falseAlarm, registry.test.ts holds gap dates to revisitMaxMonths, and
 * the rest wait for the loops to run.
 */
export const LOOP_RULES = {
  /** A rate leans toward the shipped default with the weight of 5 outputs, so a new brand starts at the default (as PRIOR_N0 does in reward.ts). */
  blendM: 5,
  /** A verdict is read only at these outputs per side, then every lookEvery up to lastLook, because reading daily turns 5% false alarms into about 26%. */
  looks: [10, 20, 40],
  /** After those looks the windows grow by 40 outputs a side, so a busy scope is read again without being read daily. */
  lookEvery: 40,
  /** The windows stop at 120 outputs a side, because every extra look adds a chance of a false same and longer windows reach back across seasons. */
  lastLook: 120,
  /** Each look reads a 97.5% range for the change, which keeps a change that did nothing near 1% false better or worse across all five looks. */
  verdictZ: 2.24,
  /** A change that did nothing may read better or worse, and a change of one band may read same, at most 5% of the time across all looks, when each output's outcome stands on its own. */
  falseAlarm: 0.05,
  /** Months until the holdback can read a band sized change are worked out at 80% power, the usual level for planning a test. */
  holdbackPowerZ: 0.84,
  /** A scope's first 10 outputs never serve as a before window, so a cold start is never what a change is judged against. */
  warmUp: 10,
  /** About 1 decision in 20 per scope leaves out defaults learned across brands and image styles adopted from votes, never a rule a person kept, so the fleet can check that learning helps. */
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
  /** A brand is stuck on a kind once 10 more of it are made while it stays at Stamped or at Signalled, so a busy brand's stall shows within days. */
  stallOutputs: 10,
  /** Or once it stays there 28 days, whichever comes first: the stages' own window, so a quiet brand's stall still shows. */
  stallDays: 28,
  /** Numbers of things across brands, shares and industry splits show only from 10 organisations, so no one brand can be picked out; counts of organisations (per step, stuck, by refusal reason and with a Go back card) show below 10 to the people who run the copy only, and never set defaults. */
  cellOrgs: 10,
  /** A gap's revisit date is at most 6 months ahead, so every gap is looked at again within two quarters. */
  revisitMaxMonths: 6,

  // ----- The votes learner (src/lib/loops/learners/votes.ts, step 4) -----
  /** A style's first look comes after 3 likes, with no share rule, because a brand that dislikes most images is the one whose default look is wrong. */
  firstLookLikes: 3,
  /** A later look needs 3 new likes since the look in use began, so each change rests on fresh votes. */
  newLikes: 3,
  /** A look holds at most until 40 of its votes count, the third look, so a quiet scope still moves on. */
  lookHoldMax: 40,
  /** A look liked at most once in its first 6 votes may change before its hold ends, so a look people plainly reject never waits 20 images. */
  rejectedLook: { liked: 1, votes: 6 },
  /** The learner proposes at most once a week per scope, so every change gets its own window. */
  learnEveryDays: 7,
  /** A look's words fit in 2000 characters, since image calls are priced per image and ruleTokens can't bound a look. */
  lookChars: 2000,
  /** A learner call starts only with 12 seconds left before the run's deadline, so it never runs past the tick it shares. */
  learnStartMs: 12_000,
  /** A learner call waits at most 15 seconds, and less when the deadline is nearer, then adopts nothing. */
  learnCallMs: 15_000,
  /** A run reads at most 2 images to profile them, one at a time, since each can hold about 16 MiB while it is read. */
  laneProfiles: 2,
  /** An image whose profile failed twice is left out of what a look learns from, so one bad file never blocks a style. */
  profileTries: 2,

  // ----- Outcomes and errors -----
  /** A vote counts toward the check, and a remake toward the guard, only within 14 days of the image being made, so each outcome is fixed in the order images were made. */
  outcomeDays: 14,
  /** The card says learning failed only after 3 failed days in a row, so one bad day never alarms anyone. */
  errorDays: 3,

  // ----- The lane (src/lib/loops/tick.ts) -----
  /** The lane visits at least 5 brands a run, so a copy with few brands is still visited about daily. */
  laneBrandsMin: 5,
  /** And at most 100, so one run never loads every brand at once. */
  laneBrandsMax: 100,
  /** At most 6 learner calls a run, a ceiling under the run's deadline, which decides first. */
  laneLearnCalls: 6,
  /** At most 2000 learner calls a day across a copy, the only bound on what learners spend, since learning is never metered. */
  learnCallsPerDay: 2000,
  /** Each verdict read takes at most 500 image rows, enough for the last look at 120 outputs with room for the images it leaves out. */
  verdictRows: 500,
  /** A run makes at most 2 verdict reads, one look's before and after windows, so it never holds more than 1000 image rows. */
  laneVerdictReads: 2,
  /** The lane logs that the fold is behind once the oldest week not yet folded is 42 days old, four weeks before its shards go. */
  foldBehindDays: 42,

  // ----- Storage (loop_days, src/lib/tenant/loops.ts) -----
  /** A week's counters are split over 5 shards, so a busy brand's writes never queue on one document. */
  shards: 5,
  /** A week's shards are kept 70 days after the week ends, time enough to fold them. */
  shardDays: 70,
  /** A folded week is kept 2 years after it ends, so checks and results can reach back across seasons. */
  foldedKeepDays: 730,

  // ----- Stamps (src/lib/loops/stamp.ts) -----
  /** A stamp handed to the browser is good for 7 days, time to save a draft later that week, and a copied one soon stops counting. */
  stampTokenDays: 7,

  // ----- Counts across brands (step 5) -----
  /** An organisation counts at most 20 outputs a week for each kind and signal, however made, and each image style, scaled together so shares hold. */
  orgOutputsCap: 20,

  // ----- Cards -----
  /** A kind whose cards were ignored more than half the time for 4 weeks drops to a notice, so learning stops asking people who don't answer. */
  noticeOnly: { ignoredShare: 0.5, weeks: 4 },
  /** A brand that gives no reason on 8 of 10 or more thumbs down over 4 weeks gets the reason row closed, so asking why never becomes a chore. */
  reasonFatigue: { skipped: 0.8, downVotes: 10, weeks: 4 },
} as const;
