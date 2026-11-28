import type { LayoutKey, OutlineId, SectionKey, SourceLabel } from "./types";

/**
 * Every string people see in the Raise kit, in one place, so the help page can quote them and a
 * test checks house style (src/lib/content/writingRules.ts: no dashes as punctuation, none of the
 * AI tells). Plain, short UK English that fits any business: a startup raising a seed round and a
 * plant shop borrowing for new stock read the same words. Pure and client safe.
 */

// ----- Sections, kinds and layouts -------------------------------------------------------------

export const SECTION_LABEL: Record<SectionKey, string> = {
  cover: "Cover",
  problem: "Problem",
  solution: "Solution",
  product: "Product",
  traction: "Traction",
  why_now: "Why now",
  market: "Market",
  competition: "Competition",
  business_model: "Business model",
  go_to_market: "Go to market",
  team: "Team",
  ask: "The ask",
  sales: "Sales",
  use_of_funds: "What the money is for",
  repayment: "How it repays",
};

/** A section inside a sentence: "No traction slide." */
export const SECTION_IN_SENTENCE: Record<SectionKey, string> = {
  cover: "cover",
  problem: "problem",
  solution: "solution",
  product: "product",
  traction: "traction",
  why_now: "why now",
  market: "market",
  competition: "competition",
  business_model: "business model",
  go_to_market: "go to market",
  team: "team",
  ask: "ask",
  sales: "sales",
  use_of_funds: "what the money is for",
  repayment: "how it repays",
};

export const KIND_LABEL: Record<OutlineId, string> = {
  investor_pre_seed: "Investor deck, pre-seed",
  investor_seed: "Investor deck, seed",
  lender_loan: "Lender pack",
};

export const LAYOUT_LABEL: Record<LayoutKey, string> = {
  cover: "Cover",
  statement: "Statement",
  three_points: "Three points",
  big_number: "Big number",
  chart: "Chart",
  compare: "Compare",
  team: "Team",
  ask: "Ask",
};

/** The This slide tab: what each section is for. */
export const GUIDANCE: Record<SectionKey, string> = {
  cover: "What investors look for here: who you are and what you do, in one line.",
  problem: "What investors look for here: a real problem, in your customer's words.",
  solution: "What investors look for here: how you solve it, in one clear sentence.",
  product: "What investors look for here: what it does today, shown simply.",
  traction: "What investors look for here: proof people want it.",
  why_now: "What investors look for here: why this can work now and not five years ago.",
  market: "What investors look for here: how many could buy, worked out from who buys today.",
  competition: "What investors look for here: what people use today, and who you suit better.",
  business_model: "What investors look for here: how you make money.",
  go_to_market: "What investors look for here: how you reach customers, and what works so far.",
  team: "What investors look for here: why you are the people to build it.",
  ask: "Raise to a milestone 12 to 18 months away. Say how much, what it buys and where it gets you.",
  sales: "What a lender looks for here: steady sales they can check.",
  use_of_funds: "What a lender looks for here: exactly what the money buys.",
  repayment: "What a lender looks for here: how repayments fit your sales through the year.",
};

/** A lender pack's own lines for the sections it shares with an investor deck. */
export const LENDER_GUIDANCE: Partial<Record<SectionKey, string>> = {
  cover: "What a lender looks for here: what you sell and how long you've traded.",
  team: "What a lender looks for here: who runs the business day to day.",
  business_model: "What a lender looks for here: how the business makes its money.",
  go_to_market: "What a lender looks for here: how you find customers, and what works so far.",
};

/** Shown on every slide's This slide tab. */
export const SLIDE_RULES = ["One idea a slide. The headline says the point.", "Every number says where it came from."] as const;

export const SOURCE_LABEL_WORDS: Record<SourceLabel, string> = {
  website: "From your website",
  repo: "From your repo",
  brand_map: "From your brand map",
  brand_strategy: "From your brand strategy",
  competitors: "From your competitors",
  team: "From your team list",
  about: "From About your business",
};

// ----- What a draft couldn't see: each becomes a Needs callout on its slide ---------------------

export const MISSING_WORDS = {
  team: "team bios",
  competition: "who you compete with",
  site: "what your website says you do",
  demand: "a number that shows demand",
  market: "how many could buy",
  raise: "how much you're raising",
  borrow: "how much you want to borrow",
  sales: "monthly sales",
  repayment: "how repayments fit your sales",
} as const;
export type MissingKey = keyof typeof MISSING_WORDS;

/** An outline slide's need when nothing else is missing there. */
export const OUTLINE_NEED = "the point of this slide";

/** The Needs callout on a slide in the editor, while Vizzy can work on decks here. */
export const needCallout = (what: string) => `Needs: ${what}. Add it here or tell Vizzy.`;

/** The Needs callout when Vizzy can't work on decks here. */
export const needCalloutOnly = (what: string) => `Needs: ${what}. Add it here.`;

// ----- Numbers ---------------------------------------------------------------------------------

export const BLOCK_NAME = {
  waitlistSignups: "Sign-ups to your launches",
  waitlistWeekly: "Sign-ups a week",
  signupGrowth: "Sign-up growth",
  launchSignups: (launch: string) => `People on ${launch}`,
} as const;

/** The short name a change note uses for a number. */
export const BLOCK_SHORT = {
  waitlistSignups: "sign-ups",
  signupGrowth: "sign-up growth",
  launchSignups: "people on the launch",
  typed: "number",
} as const;

export const LABEL_WORDS = {
  seen: "Seen by YouGrow",
  typed: "Typed by you",
  saidInChat: "said in chat",
  fillsOnSave: "Fills when you save",
} as const;

export const NUMBER_DIALOG = {
  title: "Insert a number",
  waitlist: "Sign-ups to your launches",
  weeks: { 4: "Last 4 weeks", 8: "Last 8 weeks", 12: "Last 12 weeks" },
  weekly: "As a chart, week by week",
  growth: "Sign-up growth",
  growthLine: "The second half of the weeks against the first",
  launch: "People on one launch",
  typed: "Type a number",
  typedName: "What it is",
  typedNamePlaceholder: "Monthly sales",
  typedValue: "Number",
  unit: "Unit",
  units: { count: "People or things", money: "Money", percent: "Percent" },
  currency: "Currency",
  per: "Per",
  pers: { none: "Nothing", month: "A month", year: "A year" },
  from: "Where it's from (optional)",
  fromPlaceholder: "Your till, or another brand",
  several: "Several, one per week or month",
  line: "YouGrow's numbers show as Seen by YouGrow. A number you type shows as Typed by you.",
  noSignups: "No sign-ups in the last 12 weeks.",
  insert: "Insert",
  cancel: "Cancel",
  remove: "Remove",
} as const;

// ----- Change notes ----------------------------------------------------------------------------

export const NOTE_WORDS = {
  firstDraft: "First draft by Vizzy.",
  outline: "First outline: each slide says what goes there.",
  putBack: (n: number) => `Put back version ${n}.`,
  unchanged: "Saved with no changes.",
  refreshed: (parts: string[]) => `Numbers refreshed: ${parts.join(", ")}.`,
} as const;

// ----- Checks (src/lib/raise/docs/checks.ts) ----------------------------------------------------

export const CHECK_WORDS = {
  number_no_source: (n: string) => `A number with no source: "${n}". Insert a number or type it as Typed by you.`,
  number_in_notes: (n: string) => `Your notes say "${n}", which no slide shows. Add it to a slide or take it out.`,
  headline_label: "The headline only names the section. Say the point, so a stranger gets it at a glance.",
  too_many_words: (n: number) => `${n} words on this slide. Keep it to 30 or fewer.`,
  missing_why_now: "No why now slide. Only about half of successful pre-seed decks have one, so it stands out.",
  missing_ask: "No ask slide. Say how much, what it buys and where it gets you.",
  missing_repayment: "No slide on how it repays. Lenders look for that first.",
  missing_section: (section: string) => `No ${section} slide. Most decks like this one have one.`,
  /** A lender pack's sections read as phrases ("what the money is for"), and a lender pack is a pack. */
  missing_section_lender: (section: string) => `No slide on ${section}. Most packs like this one have one.`,
  terms_on_ask: "The ask names a valuation or terms. Leave them off the slide and talk them through in the meeting.",
  cumulative_chart: "This chart only ever goes up, so it reads as a running total. Show each week or month on its own.",
  chart_no_source: "This chart has no source line. Say where the numbers came from.",
  too_many_in_section: (n: number, section: string) => `${n} slides on ${section}. Keep it to 3 at most.`,
  house_style: (found: string) => `Dashes or stock phrases: "${found}". Say it plainly.`,
} as const;

export const CHECKS_TAB = {
  empty: "Nothing to fix on this slide.",
  line: "Checks are hints. They never stop you saving or presenting.",
  deck: "Whole deck",
} as const;

// ----- Save as PDF -----------------------------------------------------------------------------

/** Shown before an investor deck is saved as a PDF. Exactly the plan's words (a lawyer to confirm). */
export const UK_PROMOTION_REMINDER =
  "Sending this deck to invite investment is a financial promotion in the UK. Send it only to people an exemption covers. Ask your lawyer which one applies.";

export const PDF_WORDS = {
  title: "Before you save",
  needs: (n: number) => `${n} ${n === 1 ? "slide still has" : "slides still have"} Needs. Needs don't print.`,
  print: "In the print window, choose Save as PDF. Chrome or Edge give the cleanest PDF.",
  save: "Save as PDF",
  cancel: "Cancel",
} as const;

// ----- Content page card and the Raise kit list -------------------------------------------------

export const CARD_WORDS = {
  title: "Raise kit",
  line: "Decks for investors and packs for lenders, drafted from what YouGrow knows about your business.",
  count: (n: number) => (n === 0 ? "No decks yet" : n === 1 ? "1 deck" : `${n} decks`),
  link: "Open Raise kit",
} as const;

export const LIST_WORDS = {
  title: "Raise kit",
  intro: "Decks for investors and packs for lenders. Vizzy drafts from your website, repo, brand map and numbers, and every number says where it came from.",
  legend: "What are you making?",
  investor: "Investor deck",
  preSeed: "Pre-seed, 10 slides",
  seed: "Seed, 12 slides",
  lender: "Lender pack, 5 slides",
  lenderLine: "For a bank or other lender, such as a loan for new stock.",
  brief: "Anything Vizzy should know? (optional)",
  briefPlaceholder: "Such as what the money is for, or who it's for.",
  make: "Make the first draft",
  busy: "Vizzy is drafting your deck. This takes about a minute.",
  row: { draft: (n: number) => `Draft, version ${n}`, slides: (n: number) => `${n} slides`, changed: (date: string) => `Changed ${date}` },
  empty: "No decks yet. Make a first draft and Vizzy fills it from what YouGrow knows. Anything missing shows as Needs.",
  plansLink: "See Plan and usage",
} as const;

/** Messages the admin API answers with, as people read them. */
export const RAISE_MESSAGES = {
  notIncluded: "The Raise kit isn't included in this brand's plan.",
  memberOnly: "Only an admin can make or change a deck. You can open, present and save any deck as a PDF.",
  deckLimit: "This brand has 20 decks, the most it can keep. Delete one to make another.",
  rateLimited: "You've made several drafts just now. Try again in a few minutes.",
  outlineOnly: "Vizzy couldn't write the deck just now, so each slide shows what goes there. Try Make the first draft again later.",
  stale: "Someone saved a newer version. Reload to see it, then make your change again.",
  failed: "Something went wrong. Try again.",
  tooLong: "Something on a slide is too long to save. Shorten it and try again.",
  versionNotKept: "This version isn't kept any more. Its note stays in the list.",
} as const;

// ----- The deck studio -------------------------------------------------------------------------

export const STUDIO_WORDS = {
  deckName: "Deck name",
  look: "Look: from your brand",
  lookLine: "Your logo, accent colour and fonts, from Brand. More looks come later.",
  openBrand: "Open Brand",
  askVizzy: "Ask Vizzy",
  present: "Present",
  savePdf: "Save as PDF",
  more: "More",
  refresh: "Refresh numbers",
  versions: "Versions",
  download: "Download data",
  delete: "Delete deck",
  slideN: (n: number) => `Slide ${n}`,
  checksDot: (n: number) => `${n} ${n === 1 ? "check" : "checks"}`,
  addSlide: "Add slide",
  moveUp: "Move up",
  moveDown: "Move down",
  removeSlide: "Remove slide",
  speakerNotes: "Speaker notes",
  dismiss: "Dismiss",
  insertNumber: "Insert a number",
  save: "Save changes",
  whatChanged: "What changed? (optional)",
  saved: (n: number) => `Saved as version ${n}.`,
  vizzySaved: (n: number) => `Vizzy saved version ${n}. Your changes here aren't saved.`,
  discardMine: "Discard mine and show it",
  tabs: { slide: "This slide", sources: "Sources", checks: "Checks", talk: "Talk track" },
  sourcesEmpty: "This slide doesn't draw on anything YouGrow holds yet.",
  talkLine: "Speaker notes are your talk track.",
  talkSlide: (words: number, time: string) => `${words} words, about ${time}`,
  talkDeck: (words: number, time: string) => `${words} words, about ${time} at 150 words a minute, our estimate.`,
  rehearse: "Rehearse",
  ask: "Ask Vizzy to change this slide",
  askPlaceholder: "Such as: lead with the weekly growth",
  askPrefix: (n: number, text: string) => `On slide ${n}: ${text}`,
  saveFirst: "Save your changes first.",
  refreshed: (n: number) => `Numbers refreshed as version ${n}.`,
  upToDate: "Every number is up to date.",
  versionsTitle: "Versions",
  versionN: (n: number) => `Version ${n}`,
  byVizzy: "by Vizzy",
  byYou: "by you",
  byTeammate: "by a teammate",
  view: "View",
  putBack: "Put this version back",
  versionsFoot: "Every change is kept as a new version. The first version and the newest 11 are kept whole.",
  deleteConfirm: "Delete this deck and every version? This can't be undone.",
  cancel: "Cancel",
  footer: (n: number, date: string) => `Version ${n}, ${date}`,
} as const;

/** The editor under the slide: field names and the small actions beside them. */
export const EDITOR_WORDS = {
  headline: "Headline",
  points: "Points",
  point: (n: number) => `Point ${n}`,
  addPoint: "Add a point",
  removePoint: "Remove this point",
  columns: "Columns",
  leftTitle: "Left column",
  rightTitle: "Right column",
  addRow: "Add a row",
  removeRow: "Remove this row",
  people: "People",
  name: "Name",
  role: "Role",
  line: "One line",
  addPerson: "Add a person",
  removePerson: "Remove this person",
  layout: "Layout",
  section: "Section",
  full: "A slide holds 3 numbers at most.",
  noRoom: "No room for a number here. Shorten the text first.",
  typedMissing: "Say what it is and type the number.",
  rowLabel: "Label",
  rowValue: "Number",
  launchPick: "Choose one",
  working: "Working",
  saving: "Saving",
  noteSaved: "No change to save.",
  close: "Close",
} as const;

export const PRESENT_WORDS = {
  hint: "Arrows or Space to move, N for notes, T to restart the timer, Esc to leave.",
  slideTime: (now: string, target: string) => `This slide ${now} of about ${target}`,
  totalTime: (now: string, target: string) => `Total ${now} of about ${target}`,
  slideOf: (n: number, total: number) => `Slide ${n} of ${total}`,
  back: "Back",
  next: "Next",
  notes: "Notes",
  restart: "Restart the timer",
  leave: "Leave",
  noNotes: "No speaker notes on this slide.",
} as const;

/** The card Vizzy's chat shows after it saves a deck. */
export const CARD_NOTE = "A draft. Nothing is sent or shared.";

// ----- Vizzy in chat (src/lib/canvas/kinds/raiseDeck.ts) ----------------------------------------

/** What Vizzy relays after it drafts or changes a deck. Vizzy says these, so they speak as "I". */
export const CHAT_WORDS = {
  drafted: (slides: number, kind: string) => `Saved a first draft of ${slides} slides as version 1 (${kind}).`,
  outlineOnly: "I couldn't write the words just now, so each slide says what goes there. Ask me to draft it again later.",
  needs: (n: number, list: string) => `${n} ${n === 1 ? "slide still needs" : "slides still need"} something: ${list}.`,
  noNeeds: "No slide is waiting on anything.",
  checks: (n: number) => (n === 0 ? "No checks to look at." : `${n} ${n === 1 ? "check" : "checks"} to look at on the deck's page.`),
  draftOnly: "It's a draft: nothing is sent or shared.",
  saved: (n: number, note: string) => `Saved version ${n}. ${note}`,
  unchanged: "Nothing changed, so no new version was saved.",
  upToDate: "Every number is up to date, so no new version was saved.",
  cta: "Open deck",
} as const;

/** Soft issues after a change: the version still saved. */
export const CHANGE_WARNINGS = {
  layoutHidesNumbers: (n: number) => `Slide ${n}'s layout shows numbers only inside its words: rewrite the slide to use the number, or change its layout to Big number.`,
  noData: (n: number, what: string) => `YouGrow has no ${what} to show yet, so slide ${n} shows a Needs instead.`,
  notRewritten: (n: number) => `I couldn't rewrite slide ${n} just now, so it is as it was.`,
  addOutline: (n: number) => `I couldn't write slide ${n} just now, so it says what goes there.`,
  emptyNotes: (n: number) => `I couldn't write new notes for slide ${n} just now, so they are as they were.`,
} as const;

/** Why a change can't be made, each after "Some of that change wasn't valid". */
export const OP_ISSUES = {
  noSlide: (n: number, count: number) => `there is no slide ${n}, the deck has ${count}`,
  noPlace: (n: number, count: number) => `there is no place ${n} to move to, the deck has ${count} slides`,
  tooFew: "a deck keeps at least 3 slides",
  tooMany: "a deck holds at most 16 slides",
  full: (n: number) => `slide ${n} already holds 3 numbers`,
  removed: (n: number) => `slide ${n} is removed in the same change`,
  noPeopleList: "a launch's people need the one People list, which is off here",
  noLaunch: (name: string) => `no launch called "${name}"`,
  needsLaunch: "say which launch",
  notInQuote: (digits: string) => `the number ${digits} isn't in what the person said`,
  scaledQuote: (digits: string) =>
    `these words name a figure in thousands or millions, so they hold no exact figure: quote only the words with ${digits}, or ask for the exact figure`,
} as const;
