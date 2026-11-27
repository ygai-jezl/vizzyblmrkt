import type { FieldType } from "@/lib/types/recordField";
import { RAISE_REASONS } from "@/lib/raise/reasons";

/**
 * The ready-made People fields of the investor and funding board (RAISE_PIPELINE_ENABLED): the two
 * kits behind "Set up for raising" and "Set up for funding", their field and option presets, and
 * each Stage option's role. A preset is a fixed key a field or option carries as its `preset`
 * marker once setup made or adopted it, so the board finds "Stage" whatever the team calls it.
 *
 * Keys are fixed forever; labels are only what a new field or option is called. Presets are only
 * ever added, never renamed (RAISE_PRESETS_VERSION goes up), so a later press adds just the new one.
 * Matching a team's own field or option is by label or alias, case insensitive and trimmed.
 *
 * Pure and client safe.
 */

export const RAISE_PRESETS_VERSION = 1;

export const RAISE_KITS = ["raising", "funding"] as const;
export type RaiseKit = (typeof RAISE_KITS)[number];

export function isRaiseKit(v: unknown): v is RaiseKit {
  return typeof v === "string" && (RAISE_KITS as readonly string[]).includes(v);
}

export const FIELD_PRESET_KEYS = [
  "raise.relationship",
  "raise.firm",
  "raise.tier",
  "raise.cheque",
  "raise.route_in",
  "raise.last_touch",
  "raise.next_step",
  "raise.next_step_date",
  "raise.stage",
  "raise.pass_reason",
] as const;
export type FieldPresetKey = (typeof FIELD_PRESET_KEYS)[number];

export interface FieldPreset {
  preset: FieldPresetKey;
  /** What a new field is called. */
  label: string;
  /** The type a new field gets. */
  make: FieldType;
  /** The types a team's own field may have to be used for it. */
  adopt: readonly FieldType[];
  /** Other names a team's own field may have. */
  aliases: readonly string[];
}

const field = (preset: FieldPresetKey, label: string, make: FieldType, adopt: FieldType[], aliases: string[] = []): FieldPreset =>
  Object.freeze({ preset, label, make, adopt: Object.freeze(adopt), aliases: Object.freeze(aliases) });

/** The ten field presets, in the order a new list gets them. */
export const FIELD_PRESETS: readonly FieldPreset[] = Object.freeze([
  field("raise.relationship", "Relationship", "select", ["select", "multi_select", "status"]),
  field("raise.firm", "Firm", "text", ["text"], ["Fund", "Company"]),
  field("raise.tier", "Tier", "select", ["select", "status"], ["Priority"]),
  field("raise.cheque", "Cheque", "currency", ["currency", "number"], ["Cheque size", "Amount"]),
  field("raise.route_in", "Route in", "text", ["text"], ["Intro via"]),
  field("raise.last_touch", "Last touch", "date", ["date"], ["Last contact"]),
  field("raise.next_step", "Next step", "text", ["text"]),
  field("raise.next_step_date", "Next step date", "date", ["date"], ["Next step due"]),
  field("raise.stage", "Stage", "status", ["select", "status"], ["Pipeline stage"]),
  field("raise.pass_reason", "Pass reason", "select", ["select"], ["Lost reason", "Why they passed"]),
]);

export function fieldPreset(key: string): FieldPreset | null {
  return FIELD_PRESETS.find((f) => f.preset === key) ?? null;
}

export interface OptionPreset {
  preset: string;
  label: string;
  aliases: readonly string[];
}

const option = (preset: string, label: string, aliases: string[] = []): OptionPreset => Object.freeze({ preset, label, aliases: Object.freeze(aliases) });

const RELATIONSHIP_RAISING = [option("investor", "Investor"), option("advisor", "Advisor"), option("accelerator", "Accelerator")];
const RELATIONSHIP_FUNDING = [...RELATIONSHIP_RAISING, option("lender", "Lender"), option("bank", "Bank")];
const TIERS = [option("a", "A"), option("b", "B"), option("c", "C")];
const PASSED = option("passed", "Passed", ["Lost", "Declined"]);

/** The raising kit's stages, from Research to Money in, then Passed. */
export const RAISING_STAGES: readonly OptionPreset[] = Object.freeze([
  option("research", "Research"),
  option("contacted", "Contacted"),
  option("replied", "Replied"),
  option("first_meeting", "First meeting"),
  option("next_meeting", "Next meeting"),
  option("diligence", "Diligence"),
  option("term_sheet", "Term sheet"),
  option("committed", "Committed (a promise)", ["Committed"]),
  option("money_in", "Money in"),
  PASSED,
]);

/** The funding kit's stages, for a loan or a grant: Plan, Applied, Decision, Funds in, then Passed. */
export const FUNDING_STAGES: readonly OptionPreset[] = Object.freeze([option("plan", "Plan"), option("applied", "Applied"), option("decision", "Decision"), option("funds_in", "Funds in"), PASSED]);

/** A few other names a team may have given a reason (matching is case insensitive). */
const REASON_ALIASES: Record<string, string[]> = {
  too_early: ["Too early", "Traction"],
  retention: ["Retention"],
  unit_economics: ["Unit economics", "Margins"],
  gtm_unclear: ["Go to market"],
  market_small: ["Market too small", "Small market"],
  crowded: ["Competition", "Too competitive"],
  timing: ["Timing", "Why now"],
  product_unclear: ["Product unclear"],
  no_moat: ["No moat"],
  tech_risk: ["Tech risk", "Technical risk"],
  team_gap: ["Team"],
  price_terms: ["Valuation", "Terms", "Price"],
  round_size: ["Round size"],
  trading_history: ["Trading history"],
  affordability: ["Affordability"],
  not_thesis: ["Not a fit", "Thesis"],
  wrong_stage: ["Wrong stage"],
  cheque_fit: ["Cheque size", "Check size"],
  place: ["Geography", "Location"],
  conflict: ["Conflict"],
  not_eligible: ["Not eligible", "Ineligible"],
  no_reason: ["No reason", "None given"],
  other: ["Other"],
};

const PASS_REASONS: readonly OptionPreset[] = Object.freeze(RAISE_REASONS.map((r) => option(r.key, r.label, REASON_ALIASES[r.key] ?? [])));

/** A kit's options for one option field preset, in the order the kit lays them out. */
export function kitOptions(kit: RaiseKit, preset: FieldPresetKey): readonly OptionPreset[] {
  switch (preset) {
    case "raise.relationship":
      return kit === "funding" ? RELATIONSHIP_FUNDING : RELATIONSHIP_RAISING;
    case "raise.tier":
      return TIERS;
    case "raise.stage":
      return kit === "funding" ? FUNDING_STAGES : RAISING_STAGES;
    case "raise.pass_reason":
      return PASS_REASONS;
    default:
      return [];
  }
}

/** Every kit's fields: both kits make all ten. */
export function kitFields(_kit: RaiseKit): readonly FieldPreset[] {
  return FIELD_PRESETS;
}

// --- Stage roles -------------------------------------------------------------------------------

/**
 * What a Stage option means for the board, from its preset: not started yet (open), in play
 * (active), money in (won) or passed. An option with no preset, such as a team's own "Meeting", is
 * in play.
 */
export type StageRole = "open" | "active" | "won" | "passed";

const ROLE_OF: Record<string, StageRole> = {
  research: "open",
  plan: "open",
  money_in: "won",
  funds_in: "won",
  passed: "passed",
};

export function stageRole(preset: string | null | undefined): StageRole {
  return (preset && ROLE_OF[preset]) || "active";
}

/** The stage presets only the raising kit has, and only the funding kit has (Passed is in both). */
export const RAISING_ONLY = new Set(RAISING_STAGES.map((o) => o.preset).filter((p) => p !== "passed"));
export const FUNDING_ONLY = new Set(FUNDING_STAGES.map((o) => o.preset).filter((p) => p !== "passed"));

// --- Words -------------------------------------------------------------------------------------

/** A label as matching compares it: trimmed and lowercased. */
export function sameLabel(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Whether a label is a preset's own label or one of its aliases. */
export function labelMatches(label: string, p: { label: string; aliases: readonly string[] }): boolean {
  return sameLabel(label, p.label) || p.aliases.some((a) => sameLabel(label, a));
}

/** The currencies the Amounts in choice offers. */
export const RAISE_CURRENCIES = ["GBP", "EUR", "USD", "CAD", "AUD", "NZD", "INR", "SGD"] as const;

/**
 * The currency a brand's Cheque field starts in, from its time zone: Europe/London is GBP, the rest
 * of Europe EUR, America USD (Canada's zones CAD), Australia AUD, New Zealand NZD, India INR,
 * Singapore SGD, and USD for anything else.
 */
export function currencyFor(timeZone: string | null | undefined): string {
  const tz = typeof timeZone === "string" ? timeZone.trim() : "";
  if (tz === "Europe/London") return "GBP";
  if (tz.startsWith("Europe/")) return "EUR";
  if (["America/Toronto", "America/Vancouver", "America/Edmonton", "America/Winnipeg", "America/Halifax", "America/St_Johns", "America/Regina"].includes(tz)) return "CAD";
  if (tz.startsWith("America/")) return "USD";
  if (tz.startsWith("Australia/")) return "AUD";
  if (tz === "Pacific/Auckland") return "NZD";
  if (tz === "Asia/Kolkata" || tz === "Asia/Calcutta") return "INR";
  if (tz === "Asia/Singapore") return "SGD";
  return "USD";
}
