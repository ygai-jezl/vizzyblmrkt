import type { Growth, StageKey, StageView } from "@/lib/nav/growth";
import type { ProfileAnswers } from "@/lib/types/businessProfile";
import { HOME_WORDS } from "./words";

/**
 * Home's "Your next action" (ONBOARDING_ENABLED): which stage's steps the card lists, picked from
 * what the brand told Vizzy. Pure, and no reads: the answers are on the brand record Home has
 * already read. Only the card follows the answers; the track, the line under the title, the
 * tiles and the prompts keep the growth path's own current stage. Steps inside a stage keep
 * their order, since what a step needs depends on it.
 */

/** The growth path's own order. */
const BASE: readonly StageKey[] = ["ready", "launch", "grow", "product", "retain"];

/** The stages a brand's answers bring to the front, or none when the answers don't say. */
function leadOf(answers: ProfileAnswers): StageKey[] {
  if (answers.stage === "idea" || answers.want === "waitlist") return ["launch"];
  if (answers.want === "audience") return ["grow"];
  if (answers.want === "customers") return answers.run === "app" ? ["product", "retain"] : ["launch"];
  return [];
}

/**
 * The order the card looks through the stages, or null with no answers (the growth path's own).
 * A shop or a service has connecting a product and its journeys last, never hidden: once the rest
 * is done they come up, as the track still shows them. Then the lead stage goes first.
 */
export function nextActionOrder(answers: ProfileAnswers | null | undefined): StageKey[] | null {
  if (!answers || !Object.values(answers).some(Boolean)) return null;
  const late: StageKey[] = answers.run === "shop" || answers.run === "service" ? ["product", "retain"] : [];
  const base = [...BASE.filter((k) => !late.includes(k)), ...late];
  const lead = leadOf(answers);
  return [...lead, ...base.filter((k) => !lead.includes(k))];
}

/**
 * The stage whose steps Home's card lists: the first not done in the answers' order. With no
 * answers (none given, or the welcome skipped) it is the growth path's current stage, as before.
 * Null once every stage is done, as `allRunning` is.
 */
export function nextActionStage(growth: Pick<Growth, "stages" | "current">, answers: ProfileAnswers | null | undefined): StageView | null {
  const order = nextActionOrder(answers);
  if (!order) return growth.stages.find((s) => s.key === growth.current) ?? null;
  for (const key of order) {
    const stage = growth.stages.find((s) => s.key === key);
    if (stage && stage.status !== "done") return stage;
  }
  return null;
}

/** The card's title: "Your next action" with the switch on, whether the brand answered or skipped. */
export function nextActionTitle(onboarding: boolean, stage: Pick<StageView, "label">): string {
  return onboarding ? HOME_WORDS.nextAction : `Next for ${stage.label.toLowerCase()}`;
}
