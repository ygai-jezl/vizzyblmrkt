import type { ProductConnection } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import type { ProductContext } from "@/lib/connect/protocol";
import { isAllowedLink } from "@/lib/connect/contextClient";
import { checklist, type RecipientContext } from "./fields";
import type { RenderValues } from "./render";

/**
 * What the runner knows about one recipient for one run: the stored profile
 * (built from the product's events) overlaid with the product's live context,
 * shaped for the condition walk (RecipientContext) and the renderer
 * (RenderValues). Server-only (link checks use the connection's domains).
 */

export function buildRecipientContext(a: {
  user: ProductUser;
  connection: Pick<ProductConnection, "catalog">;
  context: ProductContext | null;
  emailsSent: number;
  enrolledAtMs: number;
  nowMs: number;
}): RecipientContext {
  return {
    user: { traits: a.user.traits, steps: a.user.steps, milestones: a.user.milestones, consent: a.user.consent },
    catalog: a.connection.catalog,
    context: a.context,
    emailsSent: a.emailsSent,
    enrolledAtMs: a.enrolledAtMs,
    nowMs: a.nowMs,
  };
}

type Insight = ProductContext["insights"][number];

/**
 * The insight for this email: the heaviest one this user hasn't been shown,
 * preferring one that supports their next step. Null when there's no context
 * or nothing unused — the insight block then simply doesn't render.
 */
export function pickInsight(
  context: ProductContext | null,
  usedIds: readonly string[],
  nextStepId: string | null,
): Insight | null {
  if (!context) return null;
  const used = new Set(usedIds);
  const fresh = context.insights.filter((i) => !used.has(i.id));
  if (fresh.length === 0) return null;
  const score = (i: Insight) => i.weight + (nextStepId && i.supportsStep === nextStepId ? 1 : 0);
  return [...fresh].sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** The checklist with every link filtered to the connection's allowed link domains. */
export function safeChecklist(
  rc: RecipientContext,
  linkDomains: string[],
): Array<{ id: string; label: string; done: boolean; url: string | null }> {
  return checklist(rc).map((s) => ({ ...s, url: s.url && isAllowedLink(s.url, linkDomains) ? s.url : null }));
}

/** The product's next step, or else the first step still to do. */
export function nextStepOf(
  context: ProductContext | null,
  steps: Array<{ id: string; label: string; done: boolean; url: string | null }>,
  linkDomains: string[],
): { id: string; label: string; url: string | null } | null {
  const n = context?.nextStep;
  if (n) return { id: n.id, label: n.label, url: n.url && isAllowedLink(n.url, linkDomains) ? n.url : null };
  const first = steps.find((s) => !s.done);
  return first ? { id: first.id, label: first.label, url: first.url } : null;
}

export function buildRenderValues(a: {
  user: ProductUser;
  connection: Pick<ProductConnection, "name" | "linkDomains">;
  rc: RecipientContext;
  context: ProductContext | null;
  insight: Insight | null;
  footer: RenderValues["footer"];
}): RenderValues {
  const steps = safeChecklist(a.rc, a.connection.linkDomains);
  const next = nextStepOf(a.context, steps, a.connection.linkDomains);
  return {
    user: { id: a.user.externalUserId, first_name: a.user.firstName, last_name: a.user.lastName, email: a.user.email },
    product: { name: a.connection.name },
    traits: a.user.traits,
    facts: (a.context?.facts ?? []).map((f) => ({
      id: f.id,
      label: f.label,
      value: f.value,
      unit: f.unit ?? null,
      display: f.display ?? null,
    })),
    nextStep: next ? { label: next.label, url: next.url } : null,
    checklist: steps.map((s) => ({ label: s.label, done: s.done, url: s.url })),
    insight: a.insight ? { sentence: a.insight.sentence, aiLine: null } : null,
    footer: a.footer,
  };
}
