import type { TenantContext } from "@/lib/tenant/types";
import { FIELD_VALUES_KEY, type AgentAction } from "@/lib/types/agentAction";
import type { Made } from "@/lib/types/loopStamp";
import { countSignals, type CountDeps, type CountedSignal } from "./count";

/**
 * What a person's decision on a made thing counts (learning loops step 5, 4.4 of the plan for
 * steps 4 and 5): the shared paths that decide on Vizzy's suggestions and drafts call these once
 * a decision is saved, never inside a transaction that may run again. Each counts against the
 * thing's own stamp, so a thing with none counts nothing, and with its kind's switch off nothing is
 * written (countSignals). The mappers are pure; the counts never throw.
 */

type Signals = Partial<Record<CountedSignal, number>>;

/** Plain data as one string with its keys in order, so two values compare by what they hold. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The field values a proposal or a result holds, or undefined when it holds none. */
function fieldValues(part: Record<string, unknown> | null | undefined): unknown {
  return part && typeof part === "object" ? part[FIELD_VALUES_KEY] : undefined;
}

/**
 * The signals one move of an agent action counts, from the record before and after it:
 * - acted is kept, or edited when the field values it acted on differ from the ones proposed
 *   (a result with other data, such as the new person's id, can't say, so it counts kept);
 * - undone is undone;
 * - a person's dismissal is declined, with the why they gave if any (Work's `declined.why`, read as
 *   given); expiry, staleness and being superseded count nothing here, so those suggestions stay
 *   unused, which is what they were;
 * - approved alone counts nothing: acting on it does.
 * Null when the move counts nothing. Pure.
 */
export function agentDecisionSignals(before: AgentAction, after: AgentAction): Signals | null {
  if (before.state === after.state) return null;
  if (after.state === "acted") {
    const proposed = fieldValues(before.proposal);
    const acted = fieldValues(after.result);
    const edited = proposed !== undefined && acted !== undefined && stable(proposed) !== stable(acted);
    return edited ? { edited: 1 } : { kept: 1 };
  }
  if (after.state === "undone") return { undone: 1 };
  if (after.state === "declined" && after.declined?.reason === "dismissed") {
    const why = (after.declined as { why?: unknown }).why;
    return typeof why === "string" && why ? { declined: 1, [`declined.${why}`]: 1 } : { declined: 1 };
  }
  return null;
}

/** Count one saved move of an agent action against its stamp. Never throws. */
export async function countAgentDecision(ctx: TenantContext, before: AgentAction, after: AgentAction, deps: CountDeps = {}): Promise<void> {
  const made = before.made;
  if (!made || "unstamped" in made) return;
  const signals = agentDecisionSignals(before, after);
  if (signals) await countSignals(ctx, made, signals, deps);
}

/** A person's decision on an AI line, as the Approvals queue takes it. */
export type LineDecision =
  | { action: "approve"; line: string; subject: string | null }
  | { action: "fallback" }
  | { action: "skip" };

/**
 * What a decision on an AI line counts: approved as written is kept, approved with the line or
 * the subject changed is edited, and the standard version or a skip is declined. Only the first
 * decision on a line counts, so each line counts once however often it is decided again (a later
 * change of mind is not counted, so the counts may run a little behind). Null when it counts
 * nothing. Pure.
 */
export function lineDecisionSignal(
  draft: { aiLine?: string | null; subjectVariant?: string | null; decidedAt?: string | null },
  decision: LineDecision,
): "kept" | "edited" | "declined" | null {
  if (draft.decidedAt) return null;
  if (decision.action !== "approve") return "declined";
  const sameLine = (draft.aiLine ?? "").trim() === decision.line.trim();
  const sameSubject = (draft.subjectVariant?.trim() || null) === (decision.subject?.trim() || null);
  return sameLine && sameSubject ? "kept" : "edited";
}

/** Count a made thing's one signal when it has a stamp. Never throws. */
export async function countStamped(ctx: TenantContext, made: Made | null | undefined, signals: Signals, deps: CountDeps = {}): Promise<void> {
  if (!made || "unstamped" in made) return;
  await countSignals(ctx, made, signals, deps);
}
