import { generateJsonWithSchema, parseFirstJson, type AiUsage } from "@/lib/agents/gemini";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { FACT_KINDS } from "@/lib/onboarding/choices";
import { GOAL_METRICS, type ActionId } from "@/lib/types/nextAction";
import { cardFromModel, type CardCheck, type CheckContext } from "./card";
import {
  actionsForPrompt,
  answersForPrompt,
  anotherForPrompt,
  brandForPrompt,
  factsForPrompt,
  outcomesForPrompt,
  stateForPrompt,
  type NextActionInputs,
} from "./inputs";

/**
 * Writing the card (ADR-0020): one call to the default text model through gemini.ts, so it is
 * counted under its own purpose (aiUsage(ctx, "next_action")), with structured output whose button
 * ids are an enum of the brand's allowlist; then the checks in card.ts. Any failure is a fallback
 * reason, never an error: Home shows the steps list. Nothing here logs the founder's words.
 */

/** The call's whole time: the founder sees the steps list meanwhile, and the card when it comes. */
export const COMPOSE_TIMEOUT_MS = 20_000;
/** Choosing steps needs no thinking, and none keeps the wait short (PR A's learning measured it). */
const THINKING = 0;

/** The structured output's shape: the brand's ids as an enum, no item counts (checked in code). */
export function responseSchema(allowed: readonly ActionId[]): Record<string, unknown> {
  const text = { type: "string" };
  return {
    type: "object",
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: text,
            why: text,
            action: { type: "string", enum: [...allowed, "none"] },
            button: text,
            question: text,
            choices: { type: "array", items: { type: "object", properties: { label: text, fact: text }, required: ["label", "fact"] } },
            factKind: { type: "string", enum: [...FACT_KINDS, "none"] },
            goalMetric: { type: "string", enum: [...GOAL_METRICS, "none"] },
            goalTarget: { type: "integer" },
          },
          required: ["title", "why", "action"],
        },
      },
      note: text,
    },
    required: ["steps"],
  };
}

/** The prompt for these inputs; on Show another, with the titles of the card set aside. */
export function composePrompt(inputs: NextActionInputs, replacedTitles: readonly string[] = []): string {
  return renderPrompt("next_action.compose", {
    brand_name: brandForPrompt(inputs.brandName),
    answers: answersForPrompt(inputs.answers),
    facts: factsForPrompt(inputs.facts),
    state: stateForPrompt(inputs.growth, inputs.signals),
    outcomes: outcomesForPrompt(inputs.outcomes),
    another: anotherForPrompt(replacedTitles),
    actions: actionsForPrompt(inputs.allowed),
  });
}

export interface ComposeDeps {
  generate?: typeof generateJsonWithSchema;
}

/**
 * Ask for a card and check it. `another`: the founder pressed Show another, so a little more
 * variety and the titles of the card set aside. A missing or empty answer is "model".
 */
export async function writeCard(
  inputs: NextActionInputs,
  check: CheckContext,
  usage: AiUsage,
  opts: { another: boolean; replacedTitles?: readonly string[] },
  deps: ComposeDeps = {},
): Promise<CardCheck> {
  const generate = deps.generate ?? generateJsonWithSchema;
  const raw = await generate(composePrompt(inputs, opts.another ? (opts.replacedTitles ?? []) : []), {
    schema: responseSchema(inputs.allowed),
    timeoutMs: COMPOSE_TIMEOUT_MS,
    temperature: opts.another ? 0.8 : 0.3,
    thinkingBudget: THINKING,
    usage,
  });
  if (!raw) return { ok: false, reason: "model" };
  const parsed = parseFirstJson(raw);
  if (parsed === null) return { ok: false, reason: "schema" };
  return cardFromModel(parsed, check);
}
