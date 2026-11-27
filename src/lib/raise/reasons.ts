/**
 * Why someone passed on a raise, a loan or a grant: 23 fixed reason keys under 7 area chips
 * (RAISE_PIPELINE_ENABLED, decision 5). The keys never change once shipped, so counts by key stay
 * comparable over time; a label is only what a new Pass reason option is called, and a team can
 * rename its own options freely (the option keeps its key as its `preset`).
 *
 * - `area` is the chip a key sits under. A shop's lender keys sit under Deal, the grant key under Fit.
 * - `audience` says who usually gives that reason, so a Funding board shows lender and grant keys
 *   first within their area. `any` fits every kind of backer.
 * - `fixTo` names where the fix usually goes (the deck, the go to market plan, the raise plan,
 *   who you target). Nothing acts on it yet; a later slice suggests a fix from it.
 *
 * Pure and client safe: plain data only. Keys and areas are only ever added, never renamed
 * (RAISE_REASONS_VERSION goes up when one is added).
 */

export const RAISE_REASONS_VERSION = 1;

/** The seven area chips, in the order the Passed dialog shows them. */
export const RAISE_AREAS = [
  { key: "traction", label: "Traction" },
  { key: "market", label: "Market" },
  { key: "product", label: "Product" },
  { key: "team", label: "Team" },
  { key: "deal", label: "Deal" },
  { key: "fit", label: "Fit" },
  { key: "other", label: "Other" },
] as const;
export type RaiseArea = (typeof RAISE_AREAS)[number]["key"];

/** Who usually gives a reason. */
export type RaiseAudience = "investor" | "lender" | "grant" | "any";

/** Where the fix for a reason usually goes. */
export type RaiseFix = "readiness" | "gtm" | "product" | "deck" | "script" | "faq" | "raise_plan" | "targeting" | "none";

export interface RaiseReason {
  key: string;
  label: string;
  area: RaiseArea;
  audience: RaiseAudience;
  fixTo: readonly RaiseFix[];
}

const reason = (key: string, label: string, area: RaiseArea, audience: RaiseAudience, ...fixTo: RaiseFix[]) =>
  Object.freeze({ key, label, area, audience, fixTo: Object.freeze(fixTo) }) as RaiseReason;

/** The 23 keys, in chip order. Frozen: add new keys at the end of their area, never rename one. */
export const RAISE_REASONS: readonly RaiseReason[] = Object.freeze([
  reason("too_early", "Too early, want more traction", "traction", "investor", "readiness", "gtm"),
  reason("retention", "Usage or retention not shown", "traction", "investor", "product", "deck"),
  reason("unit_economics", "Costs, margins or payback", "traction", "any", "gtm", "deck"),
  reason("gtm_unclear", "No clear way to win customers", "traction", "any", "gtm", "deck"),
  reason("market_small", "Market looks too small", "market", "investor", "deck", "gtm"),
  reason("crowded", "Crowded market", "market", "any", "deck", "gtm", "product"),
  reason("timing", "Why now is unclear", "market", "investor", "deck", "script"),
  reason("product_unclear", "Not sure what it does", "product", "any", "deck", "script", "product"),
  reason("no_moat", "Easy to copy", "product", "investor", "product", "deck"),
  reason("tech_risk", "Doubt it can be built or scaled", "product", "investor", "product", "faq"),
  reason("team_gap", "Team or experience gap", "team", "any", "raise_plan"),
  reason("price_terms", "Price or terms", "deal", "any", "raise_plan"),
  reason("round_size", "Round too big or too small", "deal", "investor", "raise_plan"),
  reason("trading_history", "Not enough trading history", "deal", "lender", "readiness"),
  reason("affordability", "Repayments look too high", "deal", "lender", "readiness", "raise_plan"),
  reason("not_thesis", "Outside what they invest in", "fit", "investor", "targeting"),
  reason("wrong_stage", "Wrong stage for them", "fit", "any", "targeting"),
  reason("cheque_fit", "Cheque size does not fit", "fit", "any", "targeting"),
  reason("place", "Country or region", "fit", "any", "targeting"),
  reason("conflict", "Backs a competitor", "fit", "investor", "targeting"),
  reason("not_eligible", "Not eligible for this scheme", "fit", "grant", "targeting"),
  reason("no_reason", "No reason given", "other", "any", "none"),
  reason("other", "Something else", "other", "any", "none"),
]);

export type RaiseReasonKey = string;

/** The key that means they gave no reason: it counts with a blank reason. */
export const NO_REASON_KEY = "no_reason";

const BY_KEY = new Map(RAISE_REASONS.map((r) => [r.key, r]));

export function isRaiseReasonKey(v: unknown): v is RaiseReasonKey {
  return typeof v === "string" && BY_KEY.has(v);
}

/** A reason by its key, or null for one this build doesn't know. */
export function reasonOf(key: string | null | undefined): RaiseReason | null {
  return (key && BY_KEY.get(key)) || null;
}

/** An area's chip label. */
export function areaLabel(area: RaiseArea): string {
  return RAISE_AREAS.find((a) => a.key === area)?.label ?? "Other";
}

/**
 * The keys under one area chip, in their order, with the given audiences first (a Funding board
 * passes lender and grant, so a bank's reasons lead under Deal and a grant's under Fit).
 */
export function reasonsInArea(area: RaiseArea, audienceFirst: readonly RaiseAudience[] = []): RaiseReason[] {
  const inArea = RAISE_REASONS.filter((r) => r.area === area);
  if (!audienceFirst.length) return inArea;
  const first = new Set(audienceFirst);
  return [...inArea.filter((r) => first.has(r.audience)), ...inArea.filter((r) => !first.has(r.audience))];
}
