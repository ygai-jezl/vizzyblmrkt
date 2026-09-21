import { z } from "zod";
import { forTenant, getTenantById, isRateLimited } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { LifecycleDraftSchema, LifecycleSettingsSchema, type LifecycleDraft, type LifecycleJourney } from "@/lib/types/lifecycle";
import { resolveBrandVoiceText } from "@/lib/content/create/brandContext";
import { isLifecycleChatAuthoringEnabled, isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { architectLifecycleDraft, LIFECYCLE_ARCHITECT_TEMPLATES } from "@/lib/lifecycle/architect";
import { createLifecycleJourney, getLifecycleJourney, saveLifecycleDraft } from "@/lib/lifecycle/service";
import type { GraphIssue } from "@/lib/lifecycle/graph";
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
 */

const LifecycleInput = z.object({
  scope: z.object({
    connectionId: z.string().min(1).max(64),
    journeyId: z.string().min(1).max(64).nullish(),
  }),
  mode: z.enum(["template", "graph"]).default("template"),
  template: z.enum(LIFECYCLE_ARCHITECT_TEMPLATES).default("product_onboarding"),
  options: z.unknown().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  graph: z.unknown().optional(),
  pools: z.unknown().optional(),
  settings: z.unknown().optional(),
});

/** Chat drafting calls the model a dozen times per draft: keep it bounded per tenant. */
const AUTHOR_LIMIT = { prefix: "lifecycle_author", burstLimit: 5, hourlyLimit: 20 };

const issueText = (i: GraphIssue) => `${i.code}${i.nodeId ? ` at ${i.nodeId}` : ""}${i.detail ? ` (${i.detail})` : ""}`;

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

  // Build the draft.
  let draft: LifecycleDraft;
  const notes: string[] = [];
  if (req.data.mode === "template") {
    const tenant = await getTenantById(ctx.tenantId, deps.db).catch(() => null);
    const built = await architectLifecycleDraft({
      connection,
      template: req.data.template,
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
    draft = parsed.data;
  }

  // Save — only ever the DRAFT.
  const saved = existing
    ? await saveLifecycleDraft(ctx, existing.id, draft, { db: deps.db, authoredBy: "agent" })
    : await createLifecycleJourney(
        ctx,
        { name: req.data.name ?? `${connection.name} onboarding`, connectionId, template: "product_onboarding" },
        { db: deps.db, authoredBy: "agent", draft },
      );
  if (!saved.ok) return { ok: false, status: saved.status, error: saved.error, issues: saved.detail ? [saved.detail] : undefined };

  const { journey, issues } = saved.value;
  const { url, card: c } = card(journey, connection.name, draft, issues);
  const emails = c.stats[0]!.value;
  const splits = c.stats[1]!.value;
  const warnings = [...issues.map(issueText), ...notes];
  const summary = existing
    ? `I updated the draft of "${journey.name}". The live version hasn't changed — publish from the canvas when you're ready.`
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
