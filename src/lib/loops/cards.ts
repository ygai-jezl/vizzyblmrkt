import { BRAND_KIT_IMAGE_STYLE_ROUTE } from "@/lib/content/brandKit";
import { canonicalStyleId, imageStyleById } from "@/lib/content/imageStyle/catalogue";
import { isImageStyleVersionsOn } from "@/lib/content/imageStyle/flags";
import { agentActionReviewItem, getAgentAction, listOpenAgentActions, pageAgentActions } from "@/lib/ontology/agentActions";
import type { ReviewItem } from "@/lib/review/summary";
import { proposeAgentAction, transitionAgentAction } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { EventActor } from "@/lib/ontology/events";
import { agentDedupeKey, type AgentAction, type AgentActionId } from "@/lib/types/agentAction";
import type { LookRead } from "@/lib/types/loopDay";
import { countCard, type CountDeps } from "./count";
import { BRAND_SCOPE } from "./read";
import { IMAGE_STYLE_SCOPES, LOOP_RULES } from "./registry";
import { NOT_ADJUSTED_FOR_SEASON, shortDay, verdictWords } from "./verdictWords";

/**
 * Go back cards (learning loops step 4, 3.5 of the plan for steps 4 and 5): when a learned image
 * look's check reads worse, on likes or on remakes, the loops lane offers to go back to the
 * version before it, as an agent action (agent `learning`, target `learned_item`, action
 * `learned.go_back`) that Review shows under "What YouGrow learned". Nothing ever goes back on
 * its own, and a card never comes on too few.
 *
 * - Its payload is `{scope, from, to}` and its basis the read's counts: never the look's words.
 * - One card per version and look (dedupe key `learned.go_back|<scope>|v<from>|l<look>`), so a
 *   look kept once is asked about again only if a later check reads worse; and none for 30 days
 *   after a person kept it (LOOP_RULES.quietDays).
 * - At most 1 card a week per brand and 3 open at once (LOOP_RULES.cardsPerWeek and openCards).
 * - It goes after 14 days (LOOP_RULES.cardDays), counted as ignored; a person's Undo, Forget or
 *   Edit on the scope closes it as superseded.
 * Server only.
 */

export const GO_BACK_ACTION = "learned.go_back";
export const LEARNING_AGENT = "learning" as const;

const DAY_MS = 86_400_000;

/** The card's own data: which scope, from which version, back to which. */
export interface GoBackProposal {
  scope: string;
  from: number;
  to: number;
}

/** What the card shows, as counts: the read that made it, when the look began and where it came from. */
export interface GoBackBasis {
  read: LookRead;
  since: string;
  evidence: { liked: number; disliked: number; newestAt: string | null } | null;
}

const isLearningScope = (scope: unknown): scope is string => typeof scope === "string" && (IMAGE_STYLE_SCOPES as readonly string[]).includes(scope);

/** The card's payload, or null for one this build can't read. */
export function goBackOf(a: Pick<AgentAction, "action" | "proposal">): GoBackProposal | null {
  if (a.action !== GO_BACK_ACTION) return null;
  const p = a.proposal ?? {};
  const from = p.from;
  const to = p.to;
  if (!isLearningScope(p.scope) || typeof from !== "number" || typeof to !== "number" || !Number.isInteger(from) || !Number.isInteger(to) || to < 0 || to >= from) return null;
  return { scope: p.scope, from, to };
}

/** The look's name in a card: "Illustration", or "your brand's" for the brand look. */
export function lookLabel(scope: string): string {
  if (scope === BRAND_SCOPE) return "your brand's";
  return imageStyleById(canonicalStyleId(scope.slice("image_style.".length)))?.label ?? "this style's";
}

export interface CardDeps extends CountDeps {
  db?: FirestoreLike;
  now?: Date;
}

export type ProposeCardOutcome = "proposed" | "open" | "decided" | "quiet" | "week" | "full" | "invalid";

/**
 * Offer to go back from a version whose check read worse. `proposedThisWeek` is the cards the
 * brand's open week has counted already; `previous` is the card this version had before, if any.
 */
export async function proposeGoBack(
  ctx: TenantContext,
  input: GoBackProposal & { basis: GoBackBasis; proposedThisWeek: number; previous?: { id: string } | null },
  deps: CardDeps = {},
): Promise<{ outcome: ProposeCardOutcome; id?: AgentActionId }> {
  const now = deps.now ?? new Date();
  const look = input.basis.read.look;
  if (input.basis.read.call !== "worse" || look === null || !isLearningScope(input.scope) || input.to < 0 || input.to >= input.from) return { outcome: "invalid" };
  if (input.proposedThisWeek >= LOOP_RULES.cardsPerWeek) return { outcome: "week" };
  if (input.previous) {
    const prev = await getAgentAction(ctx, input.previous.id as AgentActionId, { db: deps.db }).catch(() => null);
    if (prev?.state === "proposed" || prev?.state === "approved") return { outcome: "open" };
    // Kept (declined by a person): quiet for 30 days.
    if (prev?.declined?.reason === "dismissed" && prev.decidedAt && now.getTime() - Date.parse(prev.decidedAt) < LOOP_RULES.quietDays * DAY_MS) return { outcome: "quiet" };
  }
  const open = await listOpenAgentActions(ctx, { action: GO_BACK_ACTION, limit: LOOP_RULES.openCards + 1, now: now.toISOString(), db: deps.db });
  if (open.length >= LOOP_RULES.openCards) return { outcome: "full" };
  const at = now.toISOString();
  const r = await proposeAgentAction(
    ctx,
    {
      dedupeKey: agentDedupeKey(GO_BACK_ACTION, input.scope, `v${input.from}`, `l${look}`),
      agent: LEARNING_AGENT,
      action: GO_BACK_ACTION,
      target: { type: "learned_item", id: `${input.scope}.v${input.from}` },
      personId: null,
      proposal: { scope: input.scope, from: input.from, to: input.to },
      basis: { read: input.basis.read, since: input.basis.since, evidence: input.basis.evidence },
      signals: [
        {
          kind: "metric",
          ref: `${input.scope}.v${input.from}`,
          meaning: input.basis.read.decidedBy === "guard" ? "remadeShare" : "likedShare",
          at,
        },
      ],
      review: { kind: "learned", href: `${BRAND_KIT_IMAGE_STYLE_ROUTE}#learned` },
      requestedBy: { type: "agent", id: LEARNING_AGENT },
      expiresAt: new Date(now.getTime() + LOOP_RULES.cardDays * DAY_MS).toISOString(),
      at,
    },
    { db: deps.db },
  );
  if (r.outcome !== "created") return { outcome: r.outcome, id: r.action.id };
  await countCard(ctx, "loop_learn", "proposed", deps);
  return { outcome: "proposed", id: r.action.id };
}

/** The brand's open Go back cards, newest first. */
export function openGoBackCards(ctx: TenantContext, deps: CardDeps = {}): Promise<AgentAction[]> {
  return listOpenAgentActions(ctx, { action: GO_BACK_ACTION, limit: 20, now: (deps.now ?? new Date()).toISOString(), db: deps.db });
}

/**
 * Close the brand's cards past their 14 days, as expired and ignored (agent actions also expire
 * through the lifecycle tick's sweep while person links are on; the lane does its own so the
 * cards go whatever else is on). Returns how many it closed.
 */
export async function expireGoBackCards(ctx: TenantContext, deps: CardDeps = {}): Promise<number> {
  const now = (deps.now ?? new Date()).toISOString();
  const page = await pageAgentActions(ctx, { action: GO_BACK_ACTION, state: "proposed" }, { limit: 50, db: deps.db });
  let closed = 0;
  for (const a of page.actions.filter((x) => x.expiresAt <= now)) {
    const r = await transitionAgentAction(ctx, a.id, { to: "declined", reason: "expired", by: { type: "system", id: "learning_card_expiry" }, at: now, expectRev: a.rev }, { db: deps.db });
    if (!r.ok) continue;
    closed += 1;
    await countCard(ctx, "loop_learn", "expired", deps);
    await countCard(ctx, "loop_learn", "ignored", deps);
  }
  return closed;
}

/** The soonest an open card expires, so the lane knows when a quiet brand needs a visit. */
export function soonestExpiry(open: readonly AgentAction[]): string | null {
  return open.reduce<string | null>((soonest, a) => (!soonest || a.expiresAt < soonest ? a.expiresAt : soonest), null);
}

/**
 * Close the open cards for a scope that a person's own Undo, Forget or Edit made moot, as
 * superseded, counted expired. Never throws: a card left open still can't act, as Go back checks
 * the version in use.
 */
export async function supersedeGoBackCards(ctx: TenantContext, scope: string, by: EventActor, deps: CardDeps = {}): Promise<number> {
  try {
    const open = (await openGoBackCards(ctx, deps)).filter((a) => goBackOf(a)?.scope === scope);
    let closed = 0;
    for (const a of open) {
      const r = await transitionAgentAction(ctx, a.id, { to: "declined", reason: "superseded", by, at: (deps.now ?? new Date()).toISOString(), expectRev: a.rev }, { db: deps.db });
      if (!r.ok) continue;
      closed += 1;
      await countCard(ctx, "loop_learn", "expired", deps);
    }
    return closed;
  } catch (err) {
    console.warn("[loops] closing a Go back card failed", err instanceof Error ? err.message.slice(0, 200) : "error");
    return 0;
  }
}

/** The basis a card keeps, or null for one this build can't read. */
function basisOf(a: AgentAction): GoBackBasis | null {
  const b = a.basis ?? {};
  const read = b.read as LookRead | undefined;
  if (!read || typeof read !== "object" || read.call !== "worse" || typeof b.since !== "string") return null;
  const ev = b.evidence as GoBackBasis["evidence"] | undefined;
  return { read, since: b.since, evidence: ev && typeof ev === "object" ? ev : null };
}

/** "The newer look came from 20 images you liked and 8 you didn't, newest 8 Mar." */
export function evidenceLine(e: GoBackBasis["evidence"]): string | null {
  if (!e) return null;
  const liked = `${e.liked} ${e.liked === 1 ? "image" : "images"} you liked`;
  const disliked = e.disliked > 0 ? ` and ${e.disliked} you didn't` : "";
  const newest = shortDay(e.newestAt);
  return `The newer look came from ${liked}${disliked}${newest ? `, newest ${newest}` : ""}.`;
}

/** One open card as a Review item, in the words of screen 3; null for one this build can't read. */
export function goBackReviewItem(a: AgentAction, role: TenantContext["role"]): ReviewItem | null {
  const g = goBackOf(a);
  const basis = basisOf(a);
  if (!g || !basis) return null;
  const name = lookLabel(g.scope);
  const title = g.scope === BRAND_SCOPE ? "Go back to your brand's earlier look?" : `Go back to the earlier ${name} look?`;
  const details = [verdictWords(basis.read, { since: basis.since }), NOT_ADJUSTED_FOR_SEASON, evidenceLine(basis.evidence)].filter((l): l is string => !!l);
  if (role !== "admin") details.push("Only admins can go back or keep a look.");
  const item = agentActionReviewItem(a, { title, detail: details.join(" "), action: role === "admin" ? "Review" : "Open" });
  return item ? { ...item, details, goBack: { cardId: a.id, scope: g.scope, to: g.to } } : null;
}

/** Review's "What YouGrow learned": each open Go back card, while image style versions are on. */
export async function learnedReviewItems(ctx: TenantContext, deps: CardDeps = {}): Promise<ReviewItem[]> {
  if (!isImageStyleVersionsOn()) return [];
  const open = await openGoBackCards(ctx, deps);
  return open.map((a) => goBackReviewItem(a, ctx.role)).filter((i): i is ReviewItem => !!i);
}
