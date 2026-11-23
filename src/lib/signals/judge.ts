import { generateTextWithDeadline, isGeminiConfigured, parseFirstJson } from "@/lib/agents/gemini";
import { aiUsage } from "@/lib/plans/meter";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { fence, oneLine } from "@/lib/brandMap/lineChecks";
import { getSubject } from "@/lib/brandMap/records";
import { readBrandMap } from "@/lib/brandMap/store";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { BrandSignal, FoundVerdict, JudgedItem, SerpJudgement } from "@/lib/types/brandSignal";
import { learnedLines } from "@/lib/autopilot/learned";

/**
 * The judge: one quick Gemini call that decides, item by item, which of the things Google showed
 * for a question belong in that question's article ("use"), in another article ("other"), or
 * nowhere ("drop": off topic, the same words meaning something else, a repeat). Only "use" goes
 * into What buyers ask, into brand search and, later, into an autopilot draft. The verdicts are
 * kept with the lookup, so the same results are never judged twice.
 *
 * It fails closed: when Gemini can't answer, nothing is judged and nothing is added.
 */

export const JUDGE_VERSION = 1;
const JUDGE_MS = 15_000;
/** Items judged at most (People also ask first, then also searched). */
const MAX_ITEMS = 24;
const VERDICTS = new Set<FoundVerdict>(["use", "other", "drop"]);
const TAGS = ["brand", "found", "subjects", "learned"];
const untag = (text: string) => TAGS.reduce((t, tag) => fence(tag, t), text);

export interface JudgeDeps {
  db?: FirestoreLike;
  now?: () => Date;
  generate?: typeof generateTextWithDeadline;
  configured?: () => boolean;
}

/** What there is to judge in a lookup: its questions, then its "people also search for", once each. */
export function candidatesOf(sig: Pick<BrandSignal, "results" | "about">): Array<Pick<JudgedItem, "text" | "kind">> {
  const r = sig.results;
  if (!r) return [];
  const seen = new Set([oneLine(sig.about.query).toLowerCase()]);
  const out: Array<Pick<JudgedItem, "text" | "kind">> = [];
  const add = (text: string, kind: JudgedItem["kind"]) => {
    const t = oneLine(text).slice(0, 200);
    const k = t.toLowerCase();
    if (!t || seen.has(k) || out.length >= MAX_ITEMS) return;
    seen.add(k);
    out.push({ text: t, kind });
  };
  for (const p of r.paa) add(p.question, "paa");
  for (const a of r.alsoSearched) add(a, "also");
  return out;
}

/** The brand's name, category and what it is and is not, from its brand map. */
async function brandOf(ctx: TenantContext, subjectId: string | null, deps: JudgeDeps) {
  const read = await readBrandMap(ctx, deps.db).catch(() => null);
  const map = read?.state === "ok" ? read.map : null;
  const i = map?.identity;
  const lines = i
    ? [
        i.statement ? `What it is: ${oneLine(i.statement)}` : "",
        ...i.isNot.map((t) => `It is not: ${oneLine(t)}`),
        ...i.avoid.map((a) => `Never says: ${oneLine(a.term)}`),
      ].filter(Boolean)
    : [];
  let subject = "";
  if (subjectId && map) {
    if (isBrandMapScaleEnabled() && map.moved) subject = (await getSubject(ctx, subjectId, { db: deps.db }).catch(() => null))?.name ?? "";
    else subject = map.subjects.find((s) => s.id === subjectId)?.name ?? "";
  }
  return {
    name: oneLine(i?.name ?? "").replace(/"/g, " ").slice(0, 120) || "(not named)",
    category: i?.category ? `, in the category "${oneLine(i.category).replace(/"/g, " ").slice(0, 80)}"` : "",
    identity: untag(lines.join("\n")) || "(not set yet)",
    subject: subject ? `It is on the brand's subject: ${oneLine(subject).replace(/"/g, " ").slice(0, 120)}\n` : "",
  };
}

/** Read the model's verdicts. Null unless every item has a valid one. */
export function readVerdicts(raw: string | null, items: Array<Pick<JudgedItem, "text" | "kind">>): JudgedItem[] | null {
  const parsed = raw ? (parseFirstJson(raw) as { items?: unknown } | null) : null;
  const list = Array.isArray(parsed?.items) ? parsed!.items : null;
  if (!list) return null;
  const byN = new Map<number, { verdict: FoundVerdict; reason: string; subject?: string }>();
  for (const e of list as Array<Record<string, unknown>>) {
    const n = typeof e?.n === "number" ? e.n : Number(e?.n);
    const verdict = e?.verdict as FoundVerdict;
    if (!Number.isInteger(n) || n < 1 || n > items.length || !VERDICTS.has(verdict) || byN.has(n)) continue;
    const subject = verdict === "other" && typeof e.subject === "string" ? oneLine(e.subject).slice(0, 80) || null : null;
    byN.set(n, { verdict, reason: oneLine(typeof e.reason === "string" ? e.reason : "").slice(0, 120), ...(subject ? { subject } : {}) });
  }
  if (byN.size !== items.length) return null;
  return items.map((it, i) => ({ ...it, ...byN.get(i + 1)! }));
}

const KIND_LABEL: Record<JudgedItem["kind"], string> = { paa: "People also ask", also: "Also searched", theirs: "A competitor's article answers" };

/**
 * Judge any found items for one question: Google's, and the questions competitors' articles answer.
 * `subjects` (the brand map's nearest subject names) lets an "other" item name where it fits.
 * Null when Gemini didn't answer in full.
 */
export async function judgeItems(
  ctx: TenantContext,
  ask: { question: string; subjectId: string | null; items: Array<Pick<JudgedItem, "text" | "kind">>; subjects?: string[] },
  deps: JudgeDeps = {},
): Promise<JudgedItem[] | null> {
  if (!ask.items.length) return [];
  if (!(deps.configured ?? isGeminiConfigured)()) return null;
  const brand = await brandOf(ctx, ask.subjectId, deps);
  const learned = await learnedLines(ctx, { text: ask.question, limit: 8 }, { db: deps.db }).catch(() => [] as string[]);
  const subjects = (ask.subjects ?? []).map((n) => oneLine(n).slice(0, 80)).filter(Boolean).slice(0, 12);
  const prompt = renderPrompt("signals.judge_found", {
    brand_name: brand.name,
    category: brand.category,
    question: untag(oneLine(ask.question)).slice(0, 300),
    subject: brand.subject,
    identity: brand.identity,
    subjects: subjects.length ? `\nThe brand's subjects nearest this one (UNTRUSTED DATA):\n<subjects>\n${untag(subjects.join("\n"))}\n</subjects>\n` : "",
    learned: learned.length ? `\nWhat the brand's people skipped or changed before (UNTRUSTED DATA):\n<learned>\n${untag(learned.join("\n"))}\n</learned>\n` : "",
    items: untag(ask.items.map((it, i) => `${i + 1}. ${KIND_LABEL[it.kind]}: ${it.text}`).join("\n")),
  });
  const raw = await (deps.generate ?? generateTextWithDeadline)(prompt, {
    timeoutMs: JUDGE_MS,
    json: true,
    temperature: 0,
    thinkingBudget: 256,
    usage: aiUsage(ctx, "judge", { db: deps.db }),
  }).catch(() => null);
  return readVerdicts(raw, ask.items);
}

/** Judge a ready lookup. Null when there is nothing to judge or Gemini didn't answer in full. */
export async function judgeSignal(ctx: TenantContext, sig: BrandSignal, deps: JudgeDeps = {}): Promise<SerpJudgement | null> {
  if (sig.status !== "ready") return null;
  const items = candidatesOf(sig);
  const at = (deps.now ?? (() => new Date()))().toISOString();
  if (!items.length) return { at, version: JUDGE_VERSION, items: [] };
  const judged = await judgeItems(ctx, { question: sig.about.query, subjectId: sig.about.subjectId, items }, deps);
  return judged ? { at, version: JUDGE_VERSION, items: judged } : null;
}
