import type { Campaign } from "@/lib/types/campaign";
import { draftCopy } from "@/lib/agents/creative";
import { activeBrandVoiceText } from "@/lib/content/create/activeBrandVoice";
import { JourneyGraphSchema, type JourneyGraph } from "@/lib/types/journey";
import { validateJourneyGraph } from "@/lib/email/delivery";
import { appendConvergentExit } from "@/lib/journey/exit";
import { upsertJourneyDraft } from "@/lib/journey/service";
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

export const journeyCanvasKind: CanvasKind = {
  kind: "journey",
  label: "email journey",

  async authorDraft({
    ctx,
    campaign,
    campaignId,
    rawGraph,
    brief,
  }: CanvasAuthorArgs): Promise<CanvasAuthorOutcome> {
    const parsed = JourneyGraphSchema.safeParse(rawGraph);
    if (!parsed.success) {
      return {
        ok: false,
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

    const saved = await upsertJourneyDraft(ctx, campaignId, filled, {
      refuseIfActive: true,
    });
    if (!saved.ok) return { ok: false, error: saved.error };

    return {
      ok: true,
      journeyId: saved.journey.id,
      status: saved.journey.status,
      warnings,
    };
  },
};
