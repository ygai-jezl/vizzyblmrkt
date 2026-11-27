import { ideaWord } from "@/lib/nav/terms";
import type { CompanyStage } from "./stages";
import type { MeasureKind, ProposedKind, TypedLink } from "./types";

/**
 * The suggested kind of win (work_measure_kind in src/lib/loops/registry.ts): whenever a person
 * sets how the team will know a task worked, this rule proposes a kind with its reason, with no
 * model call, and the person confirms or changes it. Both the proposal and the choice are kept, so
 * the kinds people pick over it can teach it later.
 *
 * First match wins:
 * 1. Done is the win: a Set up or a Billing and tax task, or legal and compliance work.
 * 2. Runs better: a bug, crash, error, memory, security, cost or speed task.
 * 3. Used: the task links a switch.
 * 4. Moves a number: the task is for a brand or an idea (the idea it became, or one under
 *    Connected to). In a one brand organisation every task counts as the brand's.
 * Otherwise nothing is proposed.
 *
 * Pure: the add page and the task page run it as the person types, and the server runs it again
 * on save, so the proposal never comes from a request.
 */

export interface MeasureKindInput {
  title: string;
  description?: string;
  stage?: CompanyStage | null;
  brandId?: string | null;
  ideaId?: string | null;
  typedLinks?: readonly TypedLink[];
  /** The organisation has one brand, so a whole business task is the brand's too. */
  oneBrand?: boolean;
  /** This copy calls a launch an idea (isIdeaWordsEnabled()): the reason uses its word. */
  ideaWords?: boolean;
}

/** Words that make a task legal or compliance work. */
const LEGAL =
  /\b(?:legal|lawyers?|solicitors?|contracts?|terms of (?:service|use)|privacy (?:policy|notice)|gdpr|soc ?2|iso ?27001|compliance|compliant|licen[cs]es?|trademarks?|insurance|insured|register (?:the |a |our )?(?:business|company)|(?:business|company) registration|incorporat\w*|permits?|tax|vat|dpa)\b/i;
/** Words that make a task a fix for how things run. */
const RUNS = /\b(?:bugs?|crash(?:es|ing)?|errors?|exceptions?|memory|oom|leaks?|security|vulnerabilit(?:y|ies)|cve|costs?|speed|slow(?:er|ness)?|latency|performance|timeouts?|outages?|downtime)\b/i;

const has = (re: RegExp, input: MeasureKindInput) => re.test(`${input.title}\n${input.description ?? ""}`);

/** The kind to propose for a task, with its reason; null when the rule has none. */
export function suggestMeasureKind(input: MeasureKindInput): { kind: MeasureKind; reason: string } | null {
  if (input.stage === "set_up") return { kind: "done", reason: "Set up work is finished once it is done, so there is nothing to look at after." };
  if (input.stage === "billing_tax") return { kind: "done", reason: "Billing and tax work is finished once it is done, so there is nothing to look at after." };
  if (has(LEGAL, input)) return { kind: "done", reason: "It reads like legal or compliance work, which is finished once it is done." };
  if (has(RUNS, input)) return { kind: "runs_better", reason: "It reads like a fix, so the win is that things run better." };
  if ((input.typedLinks ?? []).some((l) => l.kind === "switch" && l.name)) return { kind: "used", reason: "It names a switch, so the win is people using what the switch turns on." };
  if (input.ideaId || (input.typedLinks ?? []).some((l) => l.kind === "idea")) {
    return { kind: "moves", reason: `It serves ${ideaWord(input.ideaWords === true).a}, so the win is a number that moves for it.` };
  }
  if (input.brandId || input.oneBrand) return { kind: "moves", reason: "It is for the brand, so the win is a number that moves for the brand." };
  return null;
}

/** The rule's proposal as a measure keeps it, or null. */
export function proposedByRule(input: MeasureKindInput): ProposedKind | null {
  const s = suggestMeasureKind(input);
  return s ? { kind: s.kind, reason: s.reason, by: "rule" } : null;
}
