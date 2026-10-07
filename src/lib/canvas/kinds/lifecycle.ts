import { z } from "zod";
import { forTenant, getTenantById, isRateLimited } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import {
  continuesFromId,
  JOURNEY_COMPLETED_EVENT,
  LifecycleDraftSchema,
  LifecycleSettingsSchema,
  type LifecycleDraft,
  type LifecycleJourney,
} from "@/lib/types/lifecycle";
import { resolveBrandVoiceText } from "@/lib/content/create/brandContext";
import { isLifecycleChatAuthoringEnabled, isLifecycleEnabled, isLifecycleJourneyLinksEnabled } from "@/lib/lifecycle/flags";
import { architectAfter, architectLifecycleDraft, LIFECYCLE_ARCHITECT_TEMPLATES } from "@/lib/lifecycle/architect";
import { resolveUpstream } from "@/lib/lifecycle/chain";
import { startingAfter } from "@/lib/lifecycle/templates/followOn";
import { journeyTimeline, timelineText } from "@/lib/lifecycle/timeline";
import { createLifecycleJourney, getLifecycleJourney, saveLifecycleDraft, withJourneyEmailStyle } from "@/lib/lifecycle/service";
import type { GraphIssue } from "@/lib/lifecycle/graph";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { CanvasAuthorArgs, CanvasAuthorOutcome, CanvasKind } from "../types";

/**
 * The `lifecycle` canvas kind — Vizzy drafts or edits a connected product's
 * lifecycle journey from the chat. Two modes:
 *  - `template` (the main path): the server-side architect builds the graph and
 *    pools from the connection's catalog, then writes on-brand copy;
 *  - `graph`: the agent sends a whole draft (a custom structure, or an edit of
 *    one it read). Malformed → 422 with the problems; a structurally incomplete
 *    draft still saves, with its issues returned so the agent can repair it.
 * Always a DRAFT: publishing, the delivery mode and approvals stay human-only.
 * The tenant comes only from the signed capability token; a connection or
 * journey id from another tenant simply isn't found.
 *
 * With journey links on, `afterJourneyId` makes the journey CONTINUE FROM another
 * one on the same product: it starts when someone finishes that journey, and its
 * timing counts from then. The `follow_on` template (the default with it) builds
 * the sequence that comes next; a rebuild of a journey that already continues
 * from one keeps doing so.
 */

const LifecycleInput = z.object({
  scope: z.object({
    connectionId: z.string().min(1).max(64),
    journeyId: z.string().min(1).max(64).nullish(),
  }),
  mode: z.enum(["template", "graph"]).default("template"),
  /** Default: `follow_on` for a journey that continues from another, else `product_onboarding`. */
  template: z.enum(LIFECYCLE_ARCHITECT_TEMPLATES).optional(),
  /** The journey this one continues from (journey links). */
  afterJourneyId: z.string().min(1).max(64).nullish(),
  options: z.unknown().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  graph: z.unknown().optional(),
  pools: z.unknown().optional(),
  settings: z.unknown().optional(),
});

/** Chat drafting calls the model a dozen times per draft: keep it bounded per tenant. */
const AUTHOR_LIMIT = { prefix: "lifecycle_author", burstLimit: 5, hourlyLimit: 20 };

const issueText = (i: GraphIssue) => `${i.code}${i.nodeId ? ` at ${i.nodeId}` : ""}${i.detail ? ` (${i.detail})` : ""}`;

/**
 * Waits that will land a day late. Emails only go out in each person's send window, a moment
 * after the email before did — so a wait of whole days is just past the window on the day it was
 * meant for. Said back to the agent, which can fix it (the templates never need it).
 */
export function wholeDayWaitNotes(draft: LifecycleDraft): string[] {
  if (draft.settings.sendPolicy.anytime) return [];
  return draft.graph.nodes.flatMap((n) => {
    const w = n.type === "wait" ? n.data.wait : undefined;
    if (!w || w.windowExemptHours != null || w.minHours < 24 || w.minHours % 24 !== 0) return [];
    const days = w.minHours / 24;
    return [
      `${n.id} waits ${w.minHours} hours, which reaches the send window a day later than ${days} day${days === 1 ? "" : "s"} — use "minHours": ${w.minHours - 8} with "differentLocalDay": true`,
    ];
  });
}

function card(journey: LifecycleJourney, connectionName: string, draft: LifecycleDraft, issues: GraphIssue[]) {
  const url = `/admin/lifecycle/${journey.id}`;
  return {
    url,
    card: {
      kind: "lifecycle",
      id: journey.id,
      title: journey.name,
      subtitle: connectionName,
      url,
      stats: [
        { label: "emails", value: draft.pools.reduce((n, p) => n + p.items.length, 0) },
        { label: "splits", value: draft.graph.nodes.filter((n) => n.type === "condition").length },
        { label: "waits", value: draft.graph.nodes.filter((n) => n.type === "wait").length },
      ],
      warnings: issues.length,
    },
  };
}

/** " It starts when someone finishes "X", which sends …. Its N emails then go out about a, b and c days after that." */
function followOnTiming(draft: LifecycleDraft, from: LifecycleJourney, connection: { catalog: ProductConnection["catalog"]; defaults: ProductConnection["defaults"] }): string {
  try {
    const tz = { timezone: connection.defaults.timezone };
    const before = timelineText(journeyTimeline(from.draft, connection.catalog, tz));
    const own = journeyTimeline(draft, connection.catalog, tz);
    // Day 1 is the day they finish the journey before, so "N days after" is one less.
    const days = own.steps.map((s) => s.day - 1);
    const list = days.length > 1 ? `${days.slice(0, -1).join(", ")} and ${days.at(-1)}` : `${days[0] ?? 0}`;
    const when = own.emails ? ` Its ${own.emails} email${own.emails === 1 ? "" : "s"} then go out about ${list} days after that, in each person's send window.` : "";
    return ` It starts when someone finishes "${from.name}", which sends ${before}.${when}`;
  } catch {
    return ` It starts when someone finishes "${from.name}".`;
  }
}

/** The kind's work, with injectable dependencies (tests pass a fake db and model). */
export async function authorLifecycleDraft(
  { ctx, input, brief }: CanvasAuthorArgs,
  deps: { db?: FirestoreLike; generate?: (p: string) => Promise<string | null> } = {},
): Promise<CanvasAuthorOutcome> {
  if (!isLifecycleEnabled() || !isLifecycleChatAuthoringEnabled()) {
    return { ok: false, status: 503, error: "unavailable" };
  }
  const req = LifecycleInput.safeParse(input);
  if (!req.success) {
    return { ok: false, status: 400, error: "invalid_input", issues: req.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  if (await isRateLimited(`tenant:${ctx.tenantId}`, AUTHOR_LIMIT, { db: deps.db })) {
    return { ok: false, status: 429, error: "rate_limited" };
  }

  const repo = forTenant(ctx, deps.db);
  const { connectionId, journeyId } = req.data.scope;
  const connection = await repo.productConnections.getById(connectionId);
  if (!connection || connection.status === "revoked") return { ok: false, status: 404, error: "connection_not_found" };
  let existing: LifecycleJourney | null = null;
  if (journeyId) {
    existing = await getLifecycleJourney(ctx, journeyId, deps.db);
    if (!existing || existing.status === "archived" || existing.connectionId !== connectionId) {
      return { ok: false, status: 404, error: "journey_not_found" };
    }
  }

  // The journey it continues from: the one asked for, or — rebuilding from a template — the one it already does.
  const afterJourneyId =
    req.data.afterJourneyId ?? (req.data.mode === "template" && existing ? continuesFromId(existing.draft.settings) : null);
  let after: LifecycleJourney | null = null;
  if (afterJourneyId) {
    if (!isLifecycleJourneyLinksEnabled()) return { ok: false, status: 409, error: "journey_links_unavailable" };
    const upstream = await resolveUpstream(
      ctx,
      { id: existing?.id ?? null, connectionId },
      { trigger: { event: JOURNEY_COMPLETED_EVENT, afterJourneyId } },
      deps.db,
    );
    if (!upstream?.journey || upstream.problem) {
      return { ok: false, status: 404, error: "after_journey_not_found", issues: [`continue_from_${upstream?.problem ?? "not_found"}`] };
    }
    after = upstream.journey;
  }

  // Build the draft.
  let draft: LifecycleDraft;
  const notes: string[] = [];
  if (req.data.mode === "template") {
    const tenant = await getTenantById(ctx.tenantId, deps.db).catch(() => null);
    const built = await architectLifecycleDraft({
      connection,
      template: req.data.template ?? (after ? "follow_on" : "product_onboarding"),
      after: after ? architectAfter(after) : null,
      options: req.data.options,
      brief,
      brandVoice: resolveBrandVoiceText({ tenantBrandVoice: tenant?.brandVoice }),
      generate: deps.generate,
    });
    if ("error" in built) return { ok: false, status: 422, error: "invalid_options", issues: [built.detail] };
    draft = built.draft;
    notes.push(...built.notes);
  } else {
    const parsed = LifecycleDraftSchema.safeParse({
      graph: req.data.graph,
      pools: req.data.pools ?? existing?.draft.pools ?? [],
      settings: req.data.settings ?? existing?.draft.settings ?? LifecycleSettingsSchema.parse({}),
    });
    if (!parsed.success) {
      return {
        ok: false,
        status: 422,
        error: "invalid_graph",
        issues: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      };
    }
    draft = after ? startingAfter(parsed.data, after.id) : parsed.data;
    notes.push(...wholeDayWaitNotes(draft));
  }

  // Save — only ever the DRAFT. The journey's style isn't this kind's to set (journey_style is):
  // an edit keeps what's stored, and a new journey starts on the brand's.
  const saved = existing
    ? await saveLifecycleDraft(ctx, existing.id, draft, { db: deps.db, authoredBy: "agent", emailStyle: "keep" })
    : await createLifecycleJourney(
        ctx,
        {
          name: req.data.name ?? (after ? `After ${after.name}`.slice(0, 120) : `${connection.name} onboarding`),
          connectionId,
          template: "product_onboarding",
          ...(after ? { afterJourneyId: after.id } : {}),
        },
        { db: deps.db, authoredBy: "agent", draft: { ...draft, settings: withJourneyEmailStyle(draft.settings, undefined) } },
      );
  if (!saved.ok) return { ok: false, status: saved.status, error: saved.error, issues: saved.detail ? [saved.detail] : undefined };

  const { journey, issues } = saved.value;
  const { url, card: c } = card(journey, connection.name, draft, issues);
  const emails = c.stats[0]!.value;
  const splits = c.stats[1]!.value;
  const warnings = [...issues.map(issueText), ...notes];
  // A journey that continues from another: say when it starts and how its days fall.
  const fromId = isLifecycleJourneyLinksEnabled() ? continuesFromId(journey.draft.settings) : null;
  const from = fromId ? (after?.id === fromId ? after : await getLifecycleJourney(ctx, fromId, deps.db)) : null;
  const timing = from ? followOnTiming(journey.draft, from, connection) : "";
  const summary = existing
    ? `I updated the draft of "${journey.name}". The live version hasn't changed — publish from the canvas when you're ready.${timing}`
    : from
      ? `I drafted "${journey.name}" for ${connection.name}, saved as a draft in test mode.${timing} ` +
        `Open the canvas to review the copy and timing, then publish when you're happy — nothing sends until you do.`
      : `I drafted "${journey.name}" for ${connection.name}: ${emails} emails across ${splits} splits on onboarding progress, ` +
        `saved as a draft in test mode. Open the canvas to review the copy and timing, then publish when you're happy — nothing sends until you do.`;
  return {
    ok: true,
    id: journey.id,
    status: journey.status,
    url,
    summary: issues.length ? `${summary} It has ${issues.length} thing(s) to fix before it can be published.` : summary,
    warnings,
    card: c,
  };
}

export const lifecycleCanvasKind: CanvasKind = {
  kind: "lifecycle",
  label: "lifecycle journey",
  authorDraft: (args) => authorLifecycleDraft(args),
};
