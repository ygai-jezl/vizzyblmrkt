import { withStep } from "@/lib/nextAction/arrange";
import type { CardStepView, CardView } from "@/lib/nextAction/view";
import { NEXT_ACTION_WORDS as W } from "@/lib/nextAction/words";

/**
 * What Home's Your next action card does when the founder presses something (ADR-0022), apart from
 * React so it can be tested with a stubbed fetch: write a new card, record a step's outcome, and
 * change the card on the page only once the server has the outcome.
 *
 * - Every outcome is sent for the card its step belongs to, and is applied only while that card is
 *   still the one on the page, so a late answer never puts a replaced card back.
 * - A new card is asked for once no step is open, after the outcome that closed the last one is
 *   saved, so the server reads the card as used up.
 * - Show another that could not write a card keeps the card the founder has, with a message.
 */

export type Posted = { status: number; body: Record<string, unknown> };
export type Post = (url: string, body: unknown, keepalive?: boolean) => Promise<Posted>;

export interface FlowState {
  view: CardView | null;
  writing: boolean;
  /** A problem to show (role alert). */
  message: string | null;
  /** What became of an answer (role status). */
  notice: string | null;
  /** For screen readers. */
  live: string;
}

export interface FlowDeps {
  post: Post;
  /** Wait before looking again (tests pass their own). */
  later?: (run: () => void, ms: number) => void;
}

/** What a saved outcome means for the card: applied (saved, or already decided), changed, or failed. */
export function outcomeVerdict(r: Posted): "applied" | "changed" | "failed" {
  if (r.status === 200) return "applied";
  if (r.status === 409) return r.body.error === "already_decided" ? "applied" : "changed";
  return "failed";
}

/** The line under a step's answer: whether it waits in About your business, and why not. */
export function answerLine(suggestion: unknown): string {
  switch (suggestion) {
    case "waiting":
      return W.answerWaiting;
    case "already_known":
      return W.answerKnown;
    case "too_many_waiting":
      return W.answerTooMany;
    case "too_many_facts":
      return W.answerFull;
    case "not_saved":
    case "already_decided":
      return W.answerNotSaved;
    default:
      return W.answerGot;
  }
}

const OUTCOME_URL = "/api/admin/next-action/outcome";
const COMPOSE_URL = "/api/admin/next-action";

export class NextActionFlow {
  private current: FlowState;
  private readonly listeners = new Set<() => void>();

  constructor(
    initial: CardView | null,
    private readonly deps: FlowDeps,
  ) {
    this.current = { view: initial, writing: false, message: null, notice: null, live: "" };
  }

  /** For useSyncExternalStore. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly snapshot = (): FlowState => this.current;

  private set(patch: Partial<FlowState>): void {
    this.current = { ...this.current, ...patch };
    for (const l of this.listeners) l();
  }

  /** Ask for a new card: "state" when the card is out of date or used up, "another" for Show another. */
  async compose(reason: "state" | "another", retries = 1): Promise<void> {
    this.set({ writing: true, message: null, ...(reason === "state" ? { live: W.writing } : {}) });
    const r = await this.deps.post(COMPOSE_URL, { reason });
    if (r.status === 200 && r.body.held === "busy" && retries > 0) {
      // Another tab is writing it: look once more shortly.
      (this.deps.later ?? ((run, ms) => window.setTimeout(run, ms)))(() => void this.compose(reason, retries - 1), 6000);
      return;
    }
    if (r.status !== 200) {
      this.set({ writing: false, ...(reason === "another" ? { message: r.status === 429 ? W.tooFast : W.anotherFailed } : {}) });
      return;
    }
    const next = (r.body.view ?? null) as CardView | null;
    if (reason === "another" && r.body.failed) this.set({ writing: false, message: W.anotherFailed });
    else if (reason === "another" && r.body.held === "limited") this.set({ writing: false, message: W.limited });
    else if (r.body.composed || reason === "state") this.set({ writing: false, view: next, notice: null, live: next ? W.ready : "" });
    else this.set({ writing: false });
  }

  private record(cardId: string, step: CardStepView, outcome: "done" | "dismissed" | "answered", extra: { reason?: string; choice?: number } = {}, keepalive = false) {
    return this.deps.post(OUTCOME_URL, { cardId, step: step.key, outcome, ...extra }, keepalive);
  }

  /**
   * Apply a saved outcome to the card it was for, if that card is still on the page; once no step is
   * open (or none is left), ask for a new card.
   */
  private settle(cardId: string, key: string, change: (s: CardStepView) => CardStepView | null, patch: Partial<FlowState> = {}): void {
    const cur = this.current.view;
    if (!cur || cur.cardId !== cardId) return;
    const next = withStep(cur, key, change);
    if (!next.steps.length) {
      this.set({ ...patch, view: null });
      void this.compose("state");
      return;
    }
    this.set({ ...patch, view: next });
    if (!next.steps.some((s) => s.state === "open")) void this.compose("state");
  }

  /** A page button: the page opens at once, and the outcome goes with it. */
  page(cardId: string, step: CardStepView): void {
    void this.record(cardId, step, "done", {}, true);
  }

  /** An ask button: the chat gets the prompt at once; the step is done once the server has it. */
  async ask(cardId: string, step: CardStepView, ask: (prompt: string) => void): Promise<void> {
    if (!step.button?.prompt) return;
    ask(step.button.prompt);
    const v = outcomeVerdict(await this.record(cardId, step, "done"));
    if (v === "applied") this.settle(cardId, step.key, (s) => ({ ...s, state: "done", today: true }));
    else this.set({ message: v === "changed" ? W.cardChanged : W.saveFailed });
  }

  /** A chip: the answer is the step's outcome; the line says whether it waits in About your business. */
  async answer(cardId: string, step: CardStepView, choice: number): Promise<{ ok: boolean; line: string }> {
    const label = step.question?.options[choice] ?? null;
    const r = await this.record(cardId, step, "answered", { choice });
    if (r.status !== 200) return { ok: false, line: r.status === 409 ? W.cardChanged : W.saveFailed };
    const line = answerLine(r.body.suggestion);
    this.settle(cardId, step.key, (s) => ({ ...s, state: "answered", today: true, question: s.question ? { ...s.question, picked: label } : null }), { notice: line });
    return { ok: true, line };
  }

  /** Dismiss, with the founder's optional reason: the step leaves the card once the server has it. */
  async dismiss(cardId: string, step: CardStepView, reason: string): Promise<boolean> {
    const v = outcomeVerdict(await this.record(cardId, step, "dismissed", reason ? { reason } : {}));
    if (v !== "applied") {
      this.set({ message: v === "changed" ? W.cardChanged : W.saveFailed });
      return false;
    }
    this.settle(cardId, step.key, () => null, { live: W.dismissed, message: null });
    return true;
  }
}
