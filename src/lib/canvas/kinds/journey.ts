import { z } from "zod";
import { forTenant } from "@/lib/tenant";
import { resolveProductName, type Campaign } from "@/lib/types/campaign";
import { draftCopy } from "@/lib/agents/creative";
import { activeBrandVoiceText } from "@/lib/content/create/activeBrandVoice";
import { JourneyGraphSchema, type JourneyGraph } from "@/lib/types/journey";
import { validateJourneyGraph } from "@/lib/email/delivery";
import { appendConvergentExit } from "@/lib/journey/exit";
import { upsertJourneyDraft } from "@/lib/journey/service";
import { legacyEditorMode } from "@/lib/journey/flags";
import { convertLegacyJourney } from "@/lib/lifecycle/waitlist/convert";
import { waitlistJourneyId } from "@/lib/lifecycle/waitlist/ids";
import { createWaitlistJourney, saveLifecycleDraft } from "@/lib/lifecycle/service";
import type { CanvasAuthorArgs, CanvasAuthorOutcome, CanvasKind } from "../types";

/**
 * The `journey` canvas kind — wires the email Journey Canvas to the agent
 * authoring path. Reuses the EXISTING journey schema, validator, repository, and
 * Agent 3 (Creative Director) — it adds no new persistence or validation logic.
 */

/** Fill each email node's copy via Agent 3, node by node. Never clobbers copy a
 *  human already wrote, so re-running on a partly-edited graph is safe. */
async function fillContentWithAgent3(
  campaign: Campaign,
  graph: JourneyGraph,
  brief: string,
  brandVoice: string | null,
): Promise<JourneyGraph> {
  const at = new Date().toISOString();
  const nodes = await Promise.all(
    graph.nodes.map(async (node) => {
      if (node.type !== "email") return node;

      const subject = (node.data.subject ?? "").trim();
      const body = (node.data.body ?? "").trim();
      if (subject && body) return node; // human-authored — leave it alone

      const label = node.data.label?.trim();
      const stepBrief = label ? `${brief} — step: ${label}` : brief;
      const { variants, source } = await draftCopy({
        campaign,
        brief: stepBrief,
        variantCount: 1,
        brandVoice,
      });
      const variant = variants[0];

      return {
        ...node,
        data: {
          ...node.data,
          subject: subject || variant?.subject || label || "Untitled",
          body: body || variant?.body || "",
          // Only stamp agent3 for genuine model output; the deterministic
          // fallback template is closer to "human", so don't over-claim.
          agentMeta: {
            source: source === "agent3" ? ("agent3" as const) : ("human" as const),
            at,
          },
        },
      };
    }),
  );
  return { ...graph, nodes };
}

/** The journey kind's request: its scope is a launch (legacy top-level `campaignId`, or `scope`). */
const JourneyInput = z.object({
  campaignId: z.string().min(1).optional(),
  scope: z.object({ campaignId: z.string().min(1) }).optional(),
  graph: z.unknown(),
});

function summaryFor(status: string, warnings: string[]): string {
  const base =
    `I built the email journey and saved it as a ${status}. ` +
    `Open the Journey Canvas to review the copy, then click Activate when you're happy — ` +
    `I won't send anything to your subscribers until you do.`;
  return warnings.length === 0 ? base : `${base} Heads up: ${warnings.join("; ")}.`;
}

export const journeyCanvasKind: CanvasKind = {
  kind: "journey",
  label: "email journey",

  async authorDraft({ ctx, input, brief }: CanvasAuthorArgs): Promise<CanvasAuthorOutcome> {
    const req = JourneyInput.safeParse(input);
    const campaignId = req.success ? (req.data.scope?.campaignId ?? req.data.campaignId) : undefined;
    if (!req.success || !campaignId) return { ok: false, status: 400, error: "invalid_input" };
    // The token's tenant scope: a wrong/cross-tenant id can only miss → 404.
    const campaign = await forTenant(ctx).campaigns.getById(campaignId);
    if (!campaign) return { ok: false, status: 404, error: "campaign_not_found" };

    const parsed = JourneyGraphSchema.safeParse(req.data.graph);
    if (!parsed.success) {
      return {
        ok: false,
        status: 422,
        error: "invalid_graph",
        issues: parsed.error.issues.map(
          (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
        ),
      };
    }

    // Guarantee the agent's graph ends in ONE terminal exit node that every
    // route converges into (LLM output can dangle). The hand-built canvas wires
    // exits by hand and never reaches this path.
    const converged = appendConvergentExit(parsed.data);
    // Tenant-global authored brand voice (resolved once; null ⇒ campaign tone enum only).
    const brandVoice = await activeBrandVoiceText(ctx.tenantId);
    const filled = await fillContentWithAgent3(campaign, converged, brief, brandVoice);

    // Defense-in-depth: convergence adds a node + edges and upsertJourneyDraft
    // does NOT re-validate, so re-check the SAME schema (incl. the node/edge
    // caps) the human save path enforces — otherwise an over-cap draft would
    // persist here yet 400 the next time the operator saves on the canvas.
    const recheck = JourneyGraphSchema.safeParse(filled);
    if (!recheck.success) {
      return {
        ok: false,
        status: 422,
        error: "invalid_graph",
        issues: recheck.error.issues.map(
          (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
        ),
      };
    }

    // Validate after filling: an incomplete graph is a soft warning (the draft
    // still saves for the human to finish), NOT a hard failure. Activation
    // re-runs this same check, so a half-wired draft can never go live.
    const warnings: string[] = [];
    const valid = validateJourneyGraph(filled);
    if (!valid.ok) warnings.push(`journey_incomplete:${valid.reason}`);

    // A launch moved to the lifecycle engine (engine move): the same journey is
    // saved there as a DRAFT. Its live version only changes when a human publishes.
    if (campaign.waitlistEngine === "lifecycle") return saveMovedLaunchDraft(ctx, campaign, filled, warnings);
    // Engine move D6: the original editor is retired; the launch has to move first.
    if (legacyEditorMode() !== "edit") return { ok: false, status: 409, error: "original_editor_retired" };

    const saved = await upsertJourneyDraft(ctx, campaignId, filled, {
      refuseIfActive: true,
    });
    if (!saved.ok) {
      return { ok: false, status: saved.error === "journey_active" ? 409 : 404, error: saved.error };
    }

    const url = `/admin/launches/${campaignId}/journey`;
    return {
      ok: true,
      id: saved.journey.id,
      status: saved.journey.status,
      url,
      summary: summaryFor(saved.journey.status, warnings),
      warnings,
      card: {
        kind: "journey",
        id: saved.journey.id,
        title: `${resolveProductName(campaign) || "Launch"} — email journey`,
        url,
        stats: [{ label: "emails", value: filled.nodes.filter((n) => n.type === "email").length }],
        warnings: warnings.length,
      },
    };
  },
};

async function saveMovedLaunchDraft(
  ctx: CanvasAuthorArgs["ctx"],
  campaign: Campaign,
  graph: JourneyGraph,
  warnings: string[],
): Promise<CanvasAuthorOutcome> {
  const { draft, report } = convertLegacyJourney({ graph }, { lenient: true });
  if (!draft) {
    return { ok: false, status: 422, error: "invalid_graph", issues: report.blocking.map((b) => `${b.code}: ${b.message}`) };
  }
  const id = waitlistJourneyId(campaign.id);
  const existing = await forTenant(ctx).lifecycleJourneys.getById(id);
  const saved = existing
    ? await saveLifecycleDraft(ctx, id, draft, { authoredBy: "agent" })
    : await createWaitlistJourney(ctx, { campaignId: campaign.id, draft }, { authoredBy: "agent" });
  if (!saved.ok) return { ok: false, status: saved.status, error: saved.error };
  const journey = saved.value.journey;
  const issues = saved.value.issues.map((i) => `${i.code}${i.nodeId ? `@${i.nodeId}` : ""}`);
  const all = [...warnings, ...issues.map((i) => `journey_issue:${i}`)];
  const url = `/admin/lifecycle/${journey.id}`;
  return {
    ok: true,
    id: journey.id,
    status: journey.status,
    url,
    summary:
      `I drafted the welcome emails for ${resolveProductName(campaign) || "your launch"}. Open the journey to review the copy, ` +
      `then Publish when you're happy — nothing changes for your subscribers until you do.` +
      (all.length ? ` Heads up: ${all.join("; ")}.` : ""),
    warnings: all,
    card: {
      kind: "journey",
      id: journey.id,
      title: `${resolveProductName(campaign) || "Launch"} — welcome emails`,
      url,
      stats: [{ label: "emails", value: draft.graph.nodes.filter((n) => n.type === "email").length }],
      warnings: all.length,
    },
  };
}
