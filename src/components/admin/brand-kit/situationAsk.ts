import type { ApiResponse } from "@/components/admin/connect/api";
import type { PlacedQuestion } from "@/lib/brandMap/situationQuestions";
import type { SituationQuestion } from "@/lib/brandMap/situations";

/**
 * "Find what they ask" on one buying situation (BRAND_MAP_SITUATION_ASK_ENABLED): research's
 * second step for it, as a step of a "situations" run. The page keeps its run while it lasts,
 * so asking about several situations in a row takes one research allowance (a run has 26
 * steps and half an hour), not one each against the 2 a minute limit. A run that has ended,
 * gone or run out of steps is started again, once.
 */

const MAP = "/api/admin/brand-kit/map";

export interface AskRun {
  id: string;
  expiresAt: string;
}

type Call = <T>(path: string, init?: RequestInit) => Promise<ApiResponse<T>>;

export type AskOutcome = { ok: true; questions: PlacedQuestion[]; run: AskRun } | { ok: false; status: number; data: unknown; run: AskRun | null };

/** A run ending this soon isn't worth a step: start a new one. */
const MARGIN_MS = 10_000;
const ENDED = new Set(["run_expired", "run_used_up", "no_run"]);

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export async function askSituation(situationId: string, kept: AskRun | null, deps: { api: Call; nowMs?: number }): Promise<AskOutcome> {
  const now = deps.nowMs ?? Date.now();
  const start = async (): Promise<AskRun | { status: number; data: unknown }> => {
    const r = await deps.api<{ run?: AskRun; error?: string }>(`${MAP}/runs`, post({ kind: "situations" }));
    return r.ok && r.data.run ? { id: r.data.run.id, expiresAt: r.data.run.expiresAt } : { status: r.status, data: r.data };
  };
  const ask = (run: AskRun) =>
    deps.api<{ questions?: PlacedQuestion[]; error?: string }>(`${MAP}/situations/${encodeURIComponent(situationId)}/questions`, post({ runId: run.id }));

  const reuse = kept && Date.parse(kept.expiresAt) - now > MARGIN_MS ? kept : null;
  let run: AskRun | null = reuse;
  if (!run) {
    const started = await start();
    if (!("id" in started)) return { ok: false, status: started.status, data: started.data, run: null };
    run = started;
  }
  let r = await ask(run);
  if (!r.ok && reuse && ENDED.has(String(r.data.error ?? ""))) {
    const started = await start();
    if (!("id" in started)) return { ok: false, status: started.status, data: started.data, run: null };
    run = started;
    r = await ask(run);
  }
  if (!r.ok) return { ok: false, status: r.status, data: r.data, run: ENDED.has(String(r.data.error ?? "")) ? null : run };
  return { ok: true, questions: r.data.questions ?? [], run };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What one ask came back with, in a line. */
export function askedText(questions: PlacedQuestion[]): string {
  const fresh = questions.filter((q) => q.status === "proposed").length;
  const linked = questions.filter((q) => q.linked).length;
  if (!fresh && !linked) return "Research found nothing new for it this time.";
  return [fresh ? `${plural(fresh, "new question")} to add or dismiss below` : "", linked ? `${plural(linked, "question")} you already had, now linked to it` : ""]
    .filter(Boolean)
    .join(", and ")
    .replace(/^./, (c) => c.toUpperCase())
    .concat(".");
}

/** A situation's proposed questions: those whose subject is on the map, and those on a subject that is new. */
export function proposedOf(questions: SituationQuestion[]): { onMap: string[]; onNew: string[] } {
  const proposed = questions.filter((q) => q.status === "proposed");
  return { onMap: proposed.filter((q) => !q.newSubject).map((q) => q.id), onNew: proposed.filter((q) => q.newSubject).map((q) => q.id) };
}
