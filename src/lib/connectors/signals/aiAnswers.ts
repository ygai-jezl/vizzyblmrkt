import type { TenantContext } from "@/lib/tenant";
import type { MeaningKey } from "@/lib/metrics/meanings";
import { close, meaningWords } from "@/lib/content/blog/coverage";
import { queryKey } from "@/lib/signals/store";
import { readByUse, type UseDeps } from "../byUse";
import { isAiAnswersPlanningEnabled } from "../flags";
import { AI_ANSWERS_CHIP } from "./aiAnswersPicks";

export { AI_ANSWERS_CHIP };

/**
 * AI answers for planning (CONNECTOR_AI_ANSWERS_ENABLED, ADR-0019): the prompts the brand's AI
 * answers tools monitor, read through readByUse("signals.ai_answers") from connections both
 * members and Vizzy may read, and the Next up line for a question close in wording to one of them.
 * Read once per pick. It names no tool: any connector that declares signals.ai_answers and gives
 * these numbers feeds it. Every number sits in the line's words, so Next up's check that a reason
 * names only numbers its lines hold keeps the pick.
 */

/** The numbers a monitored prompt gives, by meaning. */
export const PROMPT_MEASURES: readonly MeaningKey[] = ["promptEngines", "promptBrandMentions", "promptCompetitors", "promptCitations"];
/** The most prompts read from each connection. */
const MAX_PROMPTS = 100;

export interface MonitoredPrompt {
  text: string;
  /** By meaning: engines, the brand's mentions, competitors named, citations; null where the tool gave none. */
  m: Partial<Record<MeaningKey, number | null>>;
}

export interface AiAnswers {
  prompts: MonitoredPrompt[];
}

/** The brand's monitored prompts, or null while the switch is off. A failed read gives none. */
export async function readAiAnswers(ctx: TenantContext, deps: Omit<UseDeps, "job"> = {}): Promise<AiAnswers | null> {
  if (!isAiAnswersPlanningEnabled()) return null;
  const r = await readByUse(ctx, "signals.ai_answers", { measures: PROMPT_MEASURES, by: "topic", period: "last_28_days", limit: MAX_PROMPTS }, { ...deps, job: "next_up" });
  const prompts = r.reads.flatMap((read) => read.rows.flatMap((row) => (row.keys.topic ? [{ text: row.keys.topic, m: row.m }] : [])));
  return { prompts };
}

/** How close two texts are in the words that carry meaning: shared over all, from 0 to 1. */
function overlap(a: string, b: string): number {
  const x = new Set(meaningWords(a));
  const y = new Set(meaningWords(b));
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return x.size + y.size - shared ? shared / (x.size + y.size - shared) : 0;
}

/**
 * The monitored prompt a question matches: the same words (as the brand map keys them), else one
 * close in wording (most of its meaning words shared, coverage's own rule), the closest first and
 * then the one asked of the most engines. Null when none is close.
 */
export function matchPrompt(question: string, prompts: readonly MonitoredPrompt[]): MonitoredPrompt | null {
  const key = queryKey(question);
  const same = prompts.find((p) => queryKey(p.text) === key);
  if (same) return same;
  const near = prompts.filter((p) => close(question, p.text)).map((p) => ({ p, score: overlap(question, p.text) }));
  near.sort((a, b) => b.score - a.score || (b.p.m.promptEngines ?? 0) - (a.p.m.promptEngines ?? 0));
  return near[0]?.p ?? null;
}

/** An AI answers line about one question: its words, the chip's words, and its numbers by meaning. */
export interface AiAnswersLine {
  text: string;
  chip: string;
  m: Partial<Record<MeaningKey, number>>;
}

const n = (v: number) => Math.round(v).toLocaleString("en-GB");
const times = (v: number) => `${n(v)} time${Math.round(v) === 1 ? "" : "s"}`;
const plural = (v: number, one: string) => `${n(v)} ${one}${Math.round(v) === 1 ? "" : "s"}`;
const short = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/**
 * The line for a question close in wording to a monitored prompt: how many AI engines answer the
 * prompt, how often their answers named the brand and how many competitors, and how many citations
 * they gave. A number the tool didn't give is left out, never written as zero.
 */
export function aiAnswersLine(question: string, answers: AiAnswers | null): AiAnswersLine | null {
  if (!answers?.prompts.length) return null;
  const p = matchPrompt(question, answers.prompts);
  if (!p) return null;
  const m: AiAnswersLine["m"] = {};
  for (const k of PROMPT_MEASURES) {
    const v = p.m[k];
    if (typeof v === "number") m[k] = v;
  }
  const words = short(p.text, 120);
  const engines = m.promptEngines;
  const named = [m.promptBrandMentions !== undefined ? `you ${times(m.promptBrandMentions)}` : "", m.promptCompetitors !== undefined ? plural(m.promptCompetitors, "competitor") : ""].filter(Boolean).join(" and ");
  const asked = engines !== undefined ? `is answered by ${plural(engines, "AI engine")}` : "is monitored in AI answers";
  const said = named ? `, whose answers named ${named}` : "";
  const cited = m.promptCitations !== undefined ? `, with ${plural(m.promptCitations, "citation")} in all` : "";
  const text = `AI answers: the monitored prompt "${words}" ${asked}${said}${cited}.`;
  const chip = `"${short(p.text, 50)}" ${engines !== undefined ? `answered by ${plural(engines, "engine")}` : "monitored"}${m.promptBrandMentions !== undefined ? `, you named ${times(m.promptBrandMentions)}` : ""}`;
  return { text, chip, m };
}
