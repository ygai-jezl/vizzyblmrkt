import { forTenant, type WhereClause } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { ReviewItem } from "@/lib/review/summary";
import { AgentActionSchema, type AgentAction, type AgentActionId, type AgentActionState } from "@/lib/types/agentAction";
import type { ContactPersonId } from "./person";

/**
 * Reading agent actions (agent_actions), and turning an open one into a Review item. Writes are
 * in src/lib/tenant/agentActions.ts (proposeAgentAction and the rest, from @/lib/tenant).
 *
 * Open actions are listed per action, so one consumer's backlog can never push another's items
 * out of Review or its count. Every action expires within 90 days, so a person's open actions stay
 * a bounded set; their full agent history is listPersonEvents with the agent.* kinds.
 */

const OPEN_PAGE = { default: 50, max: 200 } as const;
const PERSON_PAGE = { default: 100, max: 200 } as const;

function clamp(limit: number | undefined, bounds: { default: number; max: number }): number {
  const n = Math.floor(limit ?? bounds.default);
  return Math.min(Math.max(1, Number.isFinite(n) ? n : bounds.default), bounds.max);
}

/** Parsed rows only: one that fails is dropped with a count, never its contents. */
function parsed(ctx: TenantContext, rows: readonly unknown[]): AgentAction[] {
  const out: AgentAction[] = [];
  for (const row of rows) {
    const r = AgentActionSchema.safeParse(row);
    if (r.success) out.push(r.data as AgentAction);
  }
  if (out.length < rows.length) console.warn(`[ontology] dropped ${rows.length - out.length} unreadable agent actions tenant=${ctx.tenantId}`);
  return out;
}

const newestFirst = (a: AgentAction, b: AgentAction) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

export async function getAgentAction(ctx: TenantContext, id: AgentActionId, opts: { db?: FirestoreLike } = {}): Promise<AgentAction | null> {
  const row = await forTenant(ctx, opts.db).agentActions.getById(id);
  return row ? (parsed(ctx, [row])[0] ?? null) : null;
}

/**
 * One action's open suggestions, newest first (index c: action and state, createdAt desc).
 * Ones past their expiry are left out (the sweep declines them). A caller with two actions calls
 * it twice.
 */
export async function listOpenAgentActions(
  ctx: TenantContext,
  opts: { action: string; limit?: number; now?: string; db?: FirestoreLike },
): Promise<AgentAction[]> {
  const rows = await forTenant(ctx, opts.db).agentActions.find({
    where: [
      ["action", "==", opts.action],
      ["state", "==", "proposed"],
    ],
    orderBy: [["createdAt", "desc"]],
    limit: clamp(opts.limit, OPEN_PAGE),
  });
  const now = opts.now ?? new Date().toISOString();
  return parsed(ctx, rows).filter((a) => a.expiresAt > now);
}

export interface ActionPage {
  actions: AgentAction[];
  /** The page's last id: the next page's `after`. */
  last: string | null;
  more: boolean;
}

async function pageBy(ctx: TenantContext, where: WhereClause[], opts: { after?: string | null; limit: number; db?: FirestoreLike }): Promise<ActionPage> {
  const rows = await forTenant(ctx, opts.db).agentActions.find({
    where,
    orderBy: [["__name__", "asc"]],
    ...(opts.after ? { startAfter: [opts.after] } : {}),
    limit: opts.limit,
  });
  return {
    actions: parsed(ctx, rows),
    last: rows.length ? rows[rows.length - 1]!.id : (opts.after ?? null),
    more: rows.length === opts.limit,
  };
}

/**
 * A person's actions in one state, by equality only (no composite index), a page at a time in id
 * order and sorted newest first within the page. For their open suggestions and the "one open
 * suggestion per field" check.
 */
export async function listAgentActionsForPerson(
  ctx: TenantContext,
  personId: ContactPersonId,
  opts: { state: AgentActionState; limit?: number; after?: string | null; db?: FirestoreLike },
): Promise<ActionPage> {
  const page = await pageBy(
    ctx,
    [
      ["personId", "==", personId],
      ["state", "==", opts.state],
    ],
    { after: opts.after, limit: clamp(opts.limit, PERSON_PAGE), db: opts.db },
  );
  return { ...page, actions: [...page.actions].sort(newestFirst) };
}

/** Every action of one kind in one state, a page at a time in id order (equality only). */
export function pageAgentActions(
  ctx: TenantContext,
  where: { action: string; state: AgentActionState },
  opts: { after?: string | null; limit: number; db?: FirestoreLike },
): Promise<ActionPage> {
  return pageBy(
    ctx,
    [
      ["action", "==", where.action],
      ["state", "==", where.state],
    ],
    { after: opts.after, limit: clamp(opts.limit, OPEN_PAGE), db: opts.db },
  );
}

/** An action's Review item id, beside the others' prefixes ("repo:", "lcj:"). */
export function agentActionReviewItemId(id: AgentActionId): `aa:${string}` {
  return `aa:${id}`;
}

/**
 * An open action as a Review item, with the consumer's own words; null once it is decided or when
 * it has no Review link.
 */
export function agentActionReviewItem(a: AgentAction, copy: { title: string; detail: string; action: string }): ReviewItem | null {
  if (!a.review || a.state !== "proposed") return null;
  return { id: agentActionReviewItemId(a.id), kind: a.review.kind, href: a.review.href, title: copy.title, detail: copy.detail, action: copy.action };
}
