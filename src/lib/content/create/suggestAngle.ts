import { z } from "zod";
import { generateTextWithDeadline, isGeminiConfigured } from "@/lib/agents/gemini";
import { retrieveSemanticKnowledgeContext } from "@/lib/agents/knowledgeRetrieval";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { clean, fence, hasAddress, hasEmail, hasPhone, oneLine } from "@/lib/brandMap/lineChecks";
import { mapQuestion, type ArticleMap } from "@/lib/content/blog/articleMap";
import { loadArticleMap, softly } from "@/lib/content/blog/mapActions";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { BlogIntent } from "@/lib/types/contentPlan";

/**
 * "Suggest an angle" (CREATE_SUGGEST_ANGLE_ENABLED): the Spark (the angle, or thesis) for a
 * new workflow, suggested from what the brand has already said. That's the brand map's
 * question, its subject and the buying situation its reader is in, what the brand says it
 * is and isn't, and the brand's own knowledge closest to it. One quick call, no web search.
 * It is a suggestion a person edits: only the brand knows whether it believes it. Never a
 * claim the material doesn't support, a link, a person's name or contact details.
 */

export const SuggestAngleBody = z.object({
  /** The workflow's name so far. */
  name: z.string().max(200).default(""),
  /** The question a blog article answers, as typed. */
  question: z.string().max(300).default(""),
  /** "Write this next": the map question, and the buying situation it is for. */
  questionId: z.string().max(64).nullable().default(null),
  situationId: z.string().max(64).nullable().default(null),
  /** "Suggest another": the angle shown, so the next says something different. */
  previous: z.string().max(600).default(""),
});
export type SuggestAngleInput = z.infer<typeof SuggestAngleBody>;

export type SuggestAngleResult =
  | { ok: true; spark: string; basis: "map" | "brand" }
  | { ok: false; status: number; error: string };

export interface SuggestAngleDeps {
  db?: FirestoreLike;
  now?: () => Date;
  modelReady?: () => boolean;
  generate?: typeof generateTextWithDeadline;
  loadMap?: typeof loadArticleMap;
  retrieve?: typeof retrieveSemanticKnowledgeContext;
}

/** Each suggestion is one short model call, a person waiting on it. */
export const SUGGEST_ANGLE_LIMIT = { prefix: "suggest_angle", burstLimit: 10, hourlyLimit: 120 };

const SUGGEST_MS = 15_000;
const MAP_MS = 4_000;
const KNOWLEDGE_MS = 4_000;
const PASSAGES = 4;
const PASSAGE_CHARS = 500;
const OTHER_QUESTIONS = 10;
export const MAX_ANGLE = 400;

const ABOUT: Record<BlogIntent, string> = {
  definition: "what it is",
  how_to: "how to do it",
  alternatives: "the alternatives",
  comparison: "how the options compare",
  integrations: "what it works with",
  use_cases: "where it's used",
  pricing: "what it costs",
  limits: "where it falls short",
  benchmarks: "what good looks like",
  other: "",
};

const TAGS = ["brand", "situation", "subject", "knowledge", "previous"];
/** Text listed in the prompt, unable to open or close any of its tags. */
const untag = (text: string) => TAGS.reduce((t, tag) => fence(tag, t), text);

/** The answer's ANGLE line, checked: no link, no contact details, never longer than MAX_ANGLE. */
export function parseAngle(text: string): string | null {
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const m = /^\s*(?:[-*•]\s*)?\**ANGLE\**\s*:\**\s*(.+)$/i.exec(raw);
    if (!m) continue;
    const said = clean(m[1] ?? "");
    if (!said || hasAddress(said) || hasEmail(said) || hasPhone(said)) return null;
    if (said.length <= MAX_ANGLE) return said;
    // Too long: up to its last whole sentence, else its last whole word.
    const cut = said.slice(0, MAX_ANGLE);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    return end > 0 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "");
  }
  return null;
}

/** The brand, as the map says it is (what it is, isn't, and the names it avoids). */
function identityLines(map: ArticleMap | null): string {
  const i = map?.identity;
  if (!i) return "(not set yet)";
  const lines = [
    i.statement ? `What it is: ${oneLine(i.statement)}` : "",
    ...i.isNot.map((t) => `It is not: ${oneLine(t)}`),
    ...i.avoid.map((a) => `Never says: ${oneLine(a.term)}${a.useInstead ? ` (says ${oneLine(a.useInstead)})` : ""}`),
  ].filter(Boolean);
  return untag(lines.join("\n")) || "(not set yet)";
}

/** Suggest a new workflow's angle from the brand's own map and knowledge. */
export async function suggestAngle(
  ctx: TenantContext,
  workspace: { id: string; name: string },
  input: SuggestAngleInput,
  deps: SuggestAngleDeps = {},
): Promise<SuggestAngleResult> {
  if (!(deps.modelReady ?? isGeminiConfigured)()) return { ok: false, status: 503, error: "no_model" };
  const typed = oneLine(input.question) || oneLine(input.name);
  if (!typed && !input.questionId) return { ok: false, status: 400, error: "nothing_to_go_on" };

  // From "Write this next": the map question, read by id with its subject (and its situation).
  const map = await softly(
    "reading the brand map for an angle",
    () =>
      (deps.loadMap ?? loadArticleMap)(ctx, { db: deps.db }, input.questionId ? { pages: true, ask: { primaryRef: input.questionId, situationId: input.situationId } } : { ask: { situationId: null } }),
    MAP_MS,
  );
  const hit = map && input.questionId ? mapQuestion(map, input.questionId) : null;
  const topic = oneLine(hit?.question.text ?? "") || typed;
  if (!topic) return { ok: false, status: 400, error: "nothing_to_go_on" };
  const situation = input.situationId && map?.situation?.id === input.situationId ? map.situation : null;

  // The brand's own knowledge closest to it (never another site's cite sources).
  const knowledge = await softly(
    "reading knowledge for an angle",
    () =>
      (deps.retrieve ?? retrieveSemanticKnowledgeContext)({
        ctx,
        ownerKind: "workspace",
        ownerId: workspace.id,
        queryText: [topic, situation?.text].filter(Boolean).join("\n"),
        limit: PASSAGES,
        bypassEnabledFlag: true,
      }),
    KNOWLEDGE_MS,
  );
  const passages = (knowledge?.chunks ?? [])
    .slice(0, PASSAGES)
    .map((c, i) => `K${i + 1}. ${oneLine([c.title, c.heading].filter(Boolean).join(" — "))}: ${oneLine(c.content).slice(0, PASSAGE_CHARS)}`);

  const others = hit
    ? hit.subject.questions
        .filter((q) => q.id !== hit.question.id)
        .slice(0, OTHER_QUESTIONS)
        .map((q) => `- ${oneLine(q.text)}${map?.answered[q.id] ? " (answered)" : ""}`)
    : [];
  const about = hit ? ABOUT[hit.question.intent] : "";
  const brandName = oneLine(map?.identity.name || workspace.name).replace(/"/g, " ").slice(0, 120);
  const category = map?.identity.category ? `, in the category "${oneLine(map.identity.category).replace(/"/g, " ").slice(0, 80)}"` : "";

  const prompt = renderPrompt("content.suggest_angle", {
    brand_name: brandName || "(not named)",
    category,
    today: (deps.now ?? (() => new Date()))().toISOString().slice(0, 10),
    topic: untag(topic).slice(0, 300),
    kind: about ? ` (a question about ${about})` : "",
    situation: situation
      ? `\nWho it's for, and the moment they're in, in their own words (UNTRUSTED DATA):\n<situation>\n${untag(
          [
            `“${oneLine(situation.text)}”`,
            situation.who ? `Who: ${oneLine(situation.who)}` : "",
            situation.moment ? `When: ${oneLine(situation.moment)}` : "",
            situation.want ? `What they want: ${oneLine(situation.want)}` : "",
            situation.feel ? `How it feels: ${oneLine(situation.feel)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        )}\n</situation>\n`
      : "",
    reader: situation ? " in that moment" : "",
    identity: identityLines(map),
    subject: hit
      ? `\nIt is on the brand map's subject "${oneLine(hit.subject.name).replace(/"/g, " ")}". The subject's other questions (those marked answered have an article already; don't repeat their angle) (UNTRUSTED DATA):\n<subject>\n${untag(others.join("\n")) || "(none yet)"}\n</subject>\n`
      : "",
    passages: untag(passages.join("\n")) || "(none)",
    previous: oneLine(input.previous)
      ? `\nAlready suggested, and not the one (say something different) (UNTRUSTED DATA):\n<previous>\n${untag(oneLine(input.previous))}\n</previous>\n`
      : "",
  });

  const answer = await (deps.generate ?? generateTextWithDeadline)(prompt, { timeoutMs: SUGGEST_MS, temperature: input.previous ? 0.9 : 0.6, thinkingBudget: 256 }).catch(() => null);
  if (answer === null) return { ok: false, status: 502, error: "suggest_failed" };
  const spark = parseAngle(answer);
  if (!spark) return { ok: false, status: 502, error: "suggest_failed" };
  return { ok: true, spark, basis: hit || situation ? "map" : "brand" };
}
