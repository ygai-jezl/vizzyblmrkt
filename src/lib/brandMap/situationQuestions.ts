import { renderPrompt } from "@/lib/agents/prompts/registry";
import { generateGroundedText, isGeminiConfigured } from "@/lib/agents/gemini";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { blogResearchThinkingBudget } from "@/lib/content/blog/flags";
import { BlogIntent } from "@/lib/types/contentPlan";
import { BRAND_MAP_RECORD_LIMITS as LIMITS, SITUATION_W_LABEL, type RecordStatus } from "@/lib/types/brandMapRecords";
import { NAME_KIND_LABEL } from "./changes";
import { embedSubjects, nearestSubjects, situationText, type EmbedDeps } from "./embed";
import { questionKey } from "./keys";
import { proposedQuestion, proposedSubject } from "./proposals";
import { parseQuestion, parseSubject } from "./records";
import { parseSituation } from "./situations";
import { readBrandMap } from "./store";

/**
 * Research's second step for buying situations (BRAND_MAP_SITUATIONS_ENABLED): for ONE
 * situation, one search-grounded call lists the questions people in it ask, worded the way
 * they type them, and puts each in one of the 25 subjects nearest the situation in meaning,
 * or names a new subject. Code checks every line, as research's other steps do: no
 * addresses, at most 2 comparison questions, at most 15 in all (a batch, not a limit on the
 * map). A new subject is matched to one on the map by its folded name, else proposed (in no
 * group, marked "looks like" one close in meaning); a question already on the map is linked
 * to the situation rather than proposed again. Everything new is PROPOSED.
 */

export const NEAREST_SUBJECTS = 25;
const MAX_ASKED = 60;
const MAX_COMPARES = 2;

const clean = (s: string) => s.replace(/\s+/g, " ").replace(/^["“”'*]+|["“”'*]+$/g, "").trim();
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const hasAddress = (s: string) => /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|ai|co|dev|app)\/\S/i.test(s);
const fence = (tag: string, text: string) => text.replace(new RegExp(`</?\\s*${tag}[^>]*>`, "gi"), " ");

export interface AskedQuestion {
  text: string;
  intent: BlogIntent;
  /** A subject listed to the model (its number), a new one by name, or nowhere. */
  place: { n: number } | { name: string } | null;
}

/** The answer's Q lines: each question once (by its words), comparisons capped, at most `max`. */
export function parseQuestionLines(text: string, subjects: number, max: number = LIMITS.runQuestions): AskedQuestion[] {
  const out: AskedQuestion[] = [];
  const seen = new Set<string>();
  let compares = 0;
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const m = /^\s*(?:[-*•]\s*)?\**Q\**\s*:\**\s*(.+)$/i.exec(raw);
    if (!m || hasAddress(raw)) continue;
    const parts = (m[1] ?? "").split(/\s*\|\s*/).map(clean);
    const words = (parts[0] ?? "").slice(0, LIMITS.questionText);
    const key = questionKey(words);
    if (!key || seen.has(key)) continue;
    const intent = BlogIntent.safeParse((parts[1] ?? "").toLowerCase().replace(/[\s-]+/g, "_"));
    const kind = intent.success ? intent.data : "other";
    if (kind === "comparison" || kind === "alternatives") {
      if (compares >= MAX_COMPARES) continue;
      compares += 1;
    }
    seen.add(key);
    const where = parts[2] ?? "";
    const numbered = /^S\s*(\d{1,3})$/i.exec(where);
    const fresh = /^NEW\s*:\s*(.+)$/i.exec(where);
    const n = numbered ? Number(numbered[1]) : NaN;
    out.push({
      text: words,
      intent: kind,
      place: Number.isInteger(n) && n >= 1 && n <= subjects ? { n } : fresh?.[1] ? { name: clean(fresh[1]).slice(0, LIMITS.subjectName) } : null,
    });
    if (out.length >= max) break;
  }
  return out;
}

export interface PlacedQuestion {
  id: string;
  text: string;
  intent: BlogIntent;
  status: RecordStatus;
  subjectId: string;
  subjectName: string;
  /** Its subject is new to the map: still a proposal, waiting for a person. */
  newSubject: boolean;
  /** It was on the map already; now it is linked to the situation too. */
  linked: boolean;
}

export interface AskDeps {
  db?: FirestoreLike;
  nowMs?: number;
  modelReady?: () => boolean;
  grounded?: typeof generateGroundedText;
  embed?: Omit<EmbedDeps, "db" | "nowMs">;
  timeoutMs?: number;
}

export type AskResult = { ok: true; questions: PlacedQuestion[] } | { ok: false; status: number; error: string };

export async function askSituationQuestions(ctx: TenantContext, situationId: string, deps: AskDeps = {}): Promise<AskResult> {
  if (!(deps.modelReady ?? isGeminiConfigured)()) return { ok: false, status: 503, error: "no_model" };
  const started = deps.nowMs ?? Date.now();
  const now = new Date(started).toISOString();
  const store = brandMapRecords(ctx, deps.db);
  const situation = parseSituation(await store.get("sit", situationId));
  if (!situation || situation.status === "dismissed") return { ok: false, status: 404, error: "no_situation" };
  const read = await readBrandMap(ctx, deps.db).catch(() => null);
  const map = read?.state === "ok" ? read.map : null;
  const identity = map?.identity;

  const near = await nearestSubjects(ctx, situationText(situation), { limit: NEAREST_SUBJECTS, statuses: ["decided", "proposed"] }, { db: deps.db, ...deps.embed }).catch(() => []);
  const subjects = (await store.getMany("sub", near.map((n) => n.ref)).catch(() => [])).flatMap((r) =>
    typeof r.name === "string" && r.status !== "dismissed" && !r.mergedInto ? [{ id: r.id, name: r.name, status: String(r.status) }] : [],
  );
  const asked = (await store.pageAll("q", { where: [["situationIds", "array-contains", situationId]], fields: ["text", "status"] }).catch(() => []))
    .filter((r) => typeof r.text === "string")
    .slice(0, MAX_ASKED);

  const prompt = renderPrompt("brand.map_situation_questions", {
    brand_name: oneLine(identity?.name ?? "").replace(/"/g, " ").slice(0, 120) || "(not named)",
    site: identity?.site || "(no website set)",
    today: now.slice(0, 10),
    identity: fence(
      "brand",
      [
        identity?.name ? `Name: ${identity.name}` : "",
        identity?.category ? `Category: ${identity.category}` : "",
        identity?.statement ? `What it is: ${identity.statement}` : "",
        ...(map?.names ?? []).filter((n) => n.kind !== "alternative").slice(0, 20).map((n) => `${NAME_KIND_LABEL[n.kind]}: ${n.name}`),
      ]
        .filter(Boolean)
        .join("\n") || "(not set yet)",
    ),
    situation: fence(
      "situation",
      [
        `“${situation.text}”`,
        situation.wText ? `${SITUATION_W_LABEL[situation.w]}: ${situation.wText}` : "",
        situation.who ? `Who: ${situation.who}` : "",
        `Whose stake: ${situation.side === "professional" ? "their own (professional)" : "the business's"}`,
        situation.want ? `What they want: ${situation.want}` : "",
        situation.feel ? `How it feels: ${situation.feel}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    subjects: fence("subjects", subjects.map((s, i) => `S${i + 1}. ${oneLine(s.name)}`).join("\n") || "(none yet)"),
    asked: fence("asked", asked.map((r) => `- ${oneLine(String(r.text))}`).join("\n") || "(none yet)"),
    alternatives: fence("alternatives", (map?.names ?? []).filter((n) => n.kind === "alternative").slice(0, 12).map((n) => n.name).join(", ") || "(none on the map)"),
    max: LIMITS.runQuestions,
  });
  const answer = await (deps.grounded ?? generateGroundedText)(prompt, { timeoutMs: deps.timeoutMs ?? 55_000, thinkingBudget: blogResearchThinkingBudget() }).catch(() => null);
  const lines = parseQuestionLines(answer?.text ?? "", subjects.length);
  if (!answer || !lines.length) return { ok: false, status: 502, error: "research_failed" };

  const reason = `Asked in “${situation.text.slice(0, 160)}”`;
  const placed: PlacedQuestion[] = [];
  const fresh = new Set<string>();
  for (const line of lines) {
    if (!line.place) continue;
    let subject: { id: string; name: string; status: string } | null = null;
    if ("n" in line.place) subject = subjects[line.place.n - 1] ?? null;
    else {
      // Matched to a subject on the map by its folded name, else proposed in no group.
      const made = await proposedSubject(ctx, store, { name: line.place.name, from: "situations", reason, now, existingOk: true });
      if (made && typeof made.name === "string") {
        subject = { id: made.id, name: made.name, status: String(made.status) };
        if (made.createdAt === now && made.status === "proposed") fresh.add(made.id);
      }
    }
    if (!subject) continue;
    const proposed = await proposedQuestion(ctx, store, { subjectId: subject.id, subjectName: subject.name, text: line.text, intent: line.intent, situationIds: [situationId], from: "situations", reason, now });
    if (proposed) {
      // A subject still proposed (this step's, or an earlier one's) is new to the map: it waits for a person.
      placed.push({ id: proposed.id, text: line.text, intent: line.intent, status: "proposed", subjectId: subject.id, subjectName: subject.name, newSubject: subject.status === "proposed", linked: false });
      continue;
    }
    // On the map already (and not dismissed): linked to the situation too.
    const [existing] = await store.find("q", { where: [["textKey", "==", questionKey(line.text)]], limit: 1 });
    const q = parseQuestion(existing ?? null);
    if (!q || q.status === "dismissed") continue;
    if (!q.situationIds.includes(situationId) && q.situationIds.length < LIMITS.situationsPerQuestion) {
      await store.claim("q", q.id, (cur) => {
        const ids = Array.isArray(cur.situationIds) ? (cur.situationIds as string[]) : [];
        return ids.includes(situationId) ? null : { situationIds: [...ids, situationId] };
      });
    }
    const on = subjects.find((s) => s.id === q.subjectId) ?? parseSubject(await store.get("sub", q.subjectId));
    placed.push({ id: q.id, text: q.text, intent: q.intent, status: q.status, subjectId: q.subjectId, subjectName: on?.name ?? "", newSubject: false, linked: true });
  }
  // New subjects get their meaning, and "looks like" one close to it on the map (best effort).
  if (fresh.size) await embedSubjects(ctx, [...fresh], { db: deps.db, nowMs: deps.nowMs, ...deps.embed }).catch(() => 0);
  return { ok: true, questions: placed };
}
