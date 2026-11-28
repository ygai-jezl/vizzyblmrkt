import type { DeckAudience, DeckStage, LayoutKey, OutlineId, SectionKey } from "./types";
import { GUIDANCE, KIND_LABEL, LENDER_GUIDANCE, MISSING_WORDS, SECTION_LABEL, type MissingKey } from "./words";

/**
 * The outlines a new deck starts from, by kind and stage (version 1): the sections in order, each
 * section's default layout, the sections most decks of that kind have (the missing section check)
 * and what goes on each slide. This is the `deck_outline` rule in src/lib/loops/registry.ts: every
 * new deck starts from it, and nothing learns which outlines led to meetings yet. Pure.
 */

export interface Outline {
  id: OutlineId;
  audience: DeckAudience;
  stage: DeckStage;
  version: 1;
  sections: readonly SectionKey[];
}

export const OUTLINES: Record<OutlineId, Outline> = {
  investor_pre_seed: {
    id: "investor_pre_seed",
    audience: "investor",
    stage: "pre_seed",
    version: 1,
    sections: ["cover", "problem", "solution", "traction", "why_now", "market", "competition", "business_model", "team", "ask"],
  },
  investor_seed: {
    id: "investor_seed",
    audience: "investor",
    stage: "seed",
    version: 1,
    sections: ["cover", "problem", "solution", "product", "traction", "why_now", "market", "competition", "business_model", "go_to_market", "team", "ask"],
  },
  lender_loan: {
    id: "lender_loan",
    audience: "lender",
    stage: "loan",
    version: 1,
    sections: ["cover", "sales", "use_of_funds", "repayment", "team"],
  },
};

export const DEFAULT_LAYOUT: Record<SectionKey, LayoutKey> = {
  cover: "cover",
  problem: "statement",
  why_now: "statement",
  solution: "three_points",
  product: "three_points",
  business_model: "three_points",
  go_to_market: "three_points",
  repayment: "three_points",
  traction: "chart",
  market: "big_number",
  sales: "big_number",
  competition: "compare",
  team: "team",
  ask: "ask",
  use_of_funds: "ask",
};

/** The sections most decks of this kind have: one missing is a check. */
export const CORE_SECTIONS: Record<DeckAudience, readonly SectionKey[]> = {
  investor: ["problem", "solution", "traction", "why_now", "team", "ask"],
  lender: ["sales", "use_of_funds", "repayment"],
};

/** The sections Add slide offers for each kind of deck. */
export const SECTIONS_FOR: Record<DeckAudience, readonly SectionKey[]> = {
  investor: OUTLINES.investor_seed.sections,
  lender: ["cover", "sales", "use_of_funds", "repayment", "team", "business_model", "go_to_market"],
};

/** What goes on each slide, for the model (never shown to people). */
export const SECTION_BRIEF: Record<SectionKey, string> = {
  cover: "the business name as the title and one line on what it does and for whom",
  problem: "the problem in the customer's own words, as one plain statement",
  solution: "how the business solves it, then up to three points on how",
  product: "what the product does today, in up to four short points",
  traction: "proof people want it: the weekly sign-ups chart and its total",
  why_now: "why this can work now, as one plain statement",
  market: "how many could buy, worked out from who buys today",
  competition: "what people use today against what this business does better, as two columns",
  business_model: "how the business makes money, in up to three points",
  go_to_market: "how it reaches customers and what works so far",
  team: "the people running it, each with one line on why them",
  ask: "how much, what it buys and the milestone it reaches, with no valuation or terms",
  sales: "the business's sales, steady and checkable, as big numbers",
  use_of_funds: "how much to borrow and exactly what the money buys, with no equity words",
  repayment: "how repayments fit the sales through the year",
};

/** What a draft couldn't see, and the slide each one becomes a Needs on. */
export const MISSING_SECTION: Record<MissingKey, SectionKey> = {
  team: "team",
  competition: "competition",
  site: "solution",
  demand: "traction",
  market: "market",
  raise: "ask",
  borrow: "use_of_funds",
  sales: "sales",
  repayment: "repayment",
};

/** The Needs a slide always carries until the amount is typed. */
export const AMOUNT_NEED: Partial<Record<SectionKey, string>> = {
  ask: MISSING_WORDS.raise,
  use_of_funds: MISSING_WORDS.borrow,
};

export function outlineIdFor(audience: DeckAudience, stage: DeckStage): OutlineId {
  if (audience === "lender") return "lender_loan";
  return stage === "seed" ? "investor_seed" : "investor_pre_seed";
}

export function outlineFor(audience: DeckAudience, stage: DeckStage): Outline {
  return OUTLINES[outlineIdFor(audience, stage)];
}

export function kindLabel(audience: DeckAudience, stage: DeckStage): string {
  return KIND_LABEL[outlineIdFor(audience, stage)];
}

export function sectionLabel(section: SectionKey): string {
  return SECTION_LABEL[section];
}

/** The This slide tab's line for a section, in a lender's terms on a lender pack. */
export function guidanceFor(section: SectionKey, audience: DeckAudience): string {
  return (audience === "lender" ? LENDER_GUIDANCE[section] : undefined) ?? GUIDANCE[section];
}
