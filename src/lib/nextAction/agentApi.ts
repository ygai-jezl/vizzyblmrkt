import { isCanvasAuthConfigured, tenantContextFromCanvasToken, verifyCanvasContext } from "@/lib/canvas/auth";
import { FOUNDER_WORDS_NOTE } from "@/lib/onboarding/agentApi";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { isNextActionCardEnabled } from "./flags";
import { PROMPT_OUTCOMES } from "./inputs";
import { isFresh, loadNextActionState } from "./service";
import { cardView, type CardStepView } from "./view";

/**
 * What Vizzy may read of Home's Your next action (NEXT_ACTION_CARD_ENABLED), through the signed
 * canvas capability token (the brand and the person's role come from it, never from a request):
 * the card on Home now, each step with what its button does and what became of it, and the newest
 * outcomes of earlier steps. Read only: Vizzy never writes, decides or dismisses a step.
 *
 * Admins only, as Home shows it: the card is written from the facts admins kept, and a dismissal's
 * reason is the person's own words (About your business says "Only your admins and Vizzy see it").
 */

export type ApiResult = { status: number; body: unknown };

export const CARD_WORDS_NOTE = `${FOUNDER_WORDS_NOTE} The card's lines are written from them, and a dismissal's reason is the person's own words.`;

export function nextActionAgentGate(req: Request): { ok: true; ctx: TenantContext } | { ok: false; result: ApiResult } {
  if (!isNextActionCardEnabled()) return { ok: false, result: { status: 503, body: { error: "unavailable" } } };
  if (!isCanvasAuthConfigured()) return { ok: false, result: { status: 503, body: { error: "canvas_auth_unconfigured" } } };
  const verified = verifyCanvasContext(req.headers.get("x-canvas-context") ?? "");
  if (!verified.ok) return { ok: false, result: { status: 401, body: { error: "unauthorized", reason: verified.error } } };
  return { ok: true, ctx: tenantContextFromCanvasToken(verified.claims) };
}

/** What a step's button does, or its question or goal, in words Vizzy can relay. */
function doesOf(s: CardStepView): Record<string, unknown> {
  if (s.button?.href) return { kind: "page", button: s.button.label, opens: s.button.href };
  if (s.button?.prompt) return { kind: "ask_vizzy", button: s.button.label, asks: s.button.prompt };
  if (s.question) return { kind: "question", question: s.question.label, choices: s.question.options, picked: s.question.picked, becomesAFact: s.question.keeps };
  if (s.goal) return { kind: "goal", now: s.goal.now, target: s.goal.target };
  return { kind: "none" };
}

/**
 * The card on Home and the newest outcomes. `status`: "card" (Vizzy's card is on Home), "steps"
 * (Home shows the steps list: no card yet, or the last one could not be used) or "none".
 */
export async function agentReadNextAction(ctx: TenantContext, deps: { db?: FirestoreLike; nowMs?: number } = {}): Promise<ApiResult> {
  if (ctx.role !== "admin") return { status: 403, body: { error: "admins_only" } };
  const state = await loadNextActionState(ctx, {}, { db: deps.db });
  const now = deps.nowMs ?? Date.now();
  const view = cardView(state.record, state.env, state.signals, now);
  const record = state.record;
  return {
    status: 200,
    body: {
      status: view ? "card" : record ? "steps" : "none",
      composedAt: record?.composedAt ?? null,
      // False when Home will ask for a new card on the next visit (what it was written from changed).
      upToDate: isFresh(state, now),
      card: view
        ? {
            done: view.done,
            total: view.total,
            note: view.note?.text ?? null,
            steps: view.steps.map((s) => ({ n: s.n, title: s.title, why: s.why, state: s.state, ...doesOf(s) })),
          }
        : null,
      recent: (record?.outcomes ?? []).slice(0, PROMPT_OUTCOMES).map((o) => ({ at: o.at, title: o.title, state: o.state, reason: o.reason, answer: o.answer })),
      link: "/admin",
      note: CARD_WORDS_NOTE,
    },
  };
}
