import { randomBytes } from "node:crypto";
import { textKey } from "@/lib/content/blog/brief";
import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { LEARNED_LIMITS, type LearnedEntry, type LearnedKind } from "@/lib/types/autopilot";
import { isAutopilotLearningEnabled } from "./flags";

/**
 * The Learned list (`autopilot_learned`): what the brand's people did while planning, kept so
 * picking and the judge do better next time. A pick skipped and why, an item moved between trays,
 * something added back after the judge left it out. People can read it and clear it (Brand ›
 * Brand map), and it is fed back as untrusted data, never as instructions.
 *
 * Queries here use no filter beyond the brand, so no index is needed.
 */

export interface LearnedDeps {
  db?: FirestoreLike;
  now?: () => Date;
}

const repoOf = (ctx: TenantContext, deps: LearnedDeps) => forTenant(ctx, deps.db).autopilotLearned;
const nowOf = (deps: LearnedDeps) => (deps.now ?? (() => new Date()))();
const clean = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

/** The words two entries share, for "closest first" without a vector. */
const words = (s: string) => new Set(textKey(s).split(" ").filter((w) => w.length > 3));

export interface LearnedInput {
  kind: LearnedKind;
  text: string;
  reason?: string;
  questionId?: string | null;
  from: LearnedEntry["from"];
}

/** Keep one thing learned. The same kind and words again replaces the older entry. */
export async function addLearned(ctx: TenantContext, input: LearnedInput, deps: LearnedDeps = {}): Promise<LearnedEntry | null> {
  const text = clean(input.text, LEARNED_LIMITS.TEXT);
  if (!text) return null;
  const repo = repoOf(ctx, deps);
  const all = await repo.find({ limit: LEARNED_LIMITS.LIST + 50 });
  const key = `${input.kind}:${textKey(text)}`;
  for (const old of all) if (`${old.kind}:${textKey(old.text)}` === key) await repo.delete(old.id).catch(() => undefined);
  // Oldest go first past the limit.
  const left = all.filter((e) => `${e.kind}:${textKey(e.text)}` !== key).sort((a, b) => a.at.localeCompare(b.at));
  for (const old of left.slice(0, Math.max(0, left.length - LEARNED_LIMITS.LIST + 1))) await repo.delete(old.id).catch(() => undefined);
  const entry = {
    kind: input.kind,
    text,
    reason: clean(input.reason ?? "", LEARNED_LIMITS.REASON),
    questionId: input.questionId ?? null,
    from: input.from,
    at: nowOf(deps).toISOString(),
    by: input.from === "person" ? (ctx.userId ?? null) : null,
  };
  return repo.create(`lrn_${randomBytes(10).toString("hex")}`, entry);
}

/** The whole list, newest first. */
export async function listLearned(ctx: TenantContext, deps: LearnedDeps = {}): Promise<LearnedEntry[]> {
  const all = await repoOf(ctx, deps).find({ limit: LEARNED_LIMITS.LIST + 50 });
  return all.sort((a, b) => b.at.localeCompare(a.at));
}

export async function removeLearned(ctx: TenantContext, id: string, deps: LearnedDeps = {}): Promise<boolean> {
  const repo = repoOf(ctx, deps);
  if (!(await repo.getById(id))) return false;
  await repo.delete(id);
  return true;
}

export async function clearLearned(ctx: TenantContext, deps: LearnedDeps = {}): Promise<number> {
  const repo = repoOf(ctx, deps);
  const all = await repo.find({ limit: LEARNED_LIMITS.LIST + 50 });
  for (const e of all) await repo.delete(e.id).catch(() => undefined);
  return all.length;
}

const LINE: Record<LearnedKind, (e: LearnedEntry) => string> = {
  skipped_pick: (e) =>
    `${e.questionId?.startsWith("refresh:") ? "Skipped refreshing the live article" : e.questionId?.startsWith("combine:") ? "Skipped combining the live articles that answer" : "Skipped as a next article"}: "${e.text}"${e.reason ? `, because ${e.reason}` : ""}`,
  moved: (e) => `Moved: "${e.text}"${e.reason ? ` (${e.reason})` : ""}`,
  left_out: (e) => `Left out as not for this brand: "${e.text}"${e.reason ? `, ${e.reason}` : ""}`,
  added_back: (e) => `Added back after being left out: "${e.text}"${e.reason ? ` (${e.reason})` : ""}`,
  added_to_article: (e) => `Added to a live article instead of a new one: "${e.text}"${e.reason ? ` (${e.reason})` : ""}`,
  wrote_anyway: (e) => `Written as a new article although a live article was close: "${e.text}"${e.reason ? ` (${e.reason})` : ""}`,
  unlinked: (e) => `Not answered by the article it was matched to: "${e.text}"${e.reason ? ` (${e.reason})` : ""}`,
};

/** One entry as a line a prompt or a person reads. */
export function learnedLine(e: LearnedEntry): string {
  return LINE[e.kind](e);
}

/**
 * What to tell picking or the judge (CREATE_AUTOPILOT_LEARNING_ENABLED): the entries closest to the
 * question by shared words, then the newest, at most `limit`. Empty with the switch off.
 */
export async function learnedLines(ctx: TenantContext, opts: { text?: string; limit?: number } = {}, deps: LearnedDeps = {}): Promise<string[]> {
  if (!isAutopilotLearningEnabled()) return [];
  const limit = opts.limit ?? 8;
  const all = await listLearned(ctx, deps).catch(() => [] as LearnedEntry[]);
  if (!all.length) return [];
  const want = opts.text ? words(opts.text) : new Set<string>();
  const shared = (e: LearnedEntry) => [...words(e.text)].filter((w) => want.has(w)).length;
  const close = want.size ? all.filter((e) => shared(e) > 0).sort((a, b) => shared(b) - shared(a)) : [];
  const picked = [...close, ...all.filter((e) => !close.includes(e))].slice(0, limit);
  return picked.map(learnedLine);
}
