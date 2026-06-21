import { enqueueEmailJob } from "@/lib/email/jobs";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";

export interface EnqueueEnrichInput {
  companyId: string;
  domain: string;
  campaignId: string;
  /** The signer's email — passed to Agent 1 ONLY for US-region tenants (§H1). */
  sampleEmail?: string | null;
}

/**
 * Enqueue a company-enrichment job. dedupeKey is the companyId, so N contacts at
 * one company schedule exactly ONE enrich (the worker also short-circuits on an
 * already-enriched company). Returns "duplicate" when one is already queued.
 *
 * RESIDENCY (§H1): the signer's email is end-user PII. We only place it in the
 * job payload for US-region tenants; for EU/Asia the worker enriches on the
 * registrable domain alone (and is additionally gated on crmConfig there).
 */
export async function enqueueContactEnrich(
  ctx: TenantContext,
  input: EnqueueEnrichInput,
  db?: FirestoreLike,
): Promise<"enqueued" | "duplicate"> {
  const payload: Record<string, unknown> = {
    companyId: input.companyId,
    domain: input.domain,
    campaignId: input.campaignId,
  };
  if (ctx.region === "us" && input.sampleEmail) payload.sampleEmail = input.sampleEmail;

  return enqueueEmailJob(
    ctx,
    {
      type: "contact_enrich",
      campaignId: input.campaignId,
      dedupeKey: `enrich:company:${input.companyId}`,
      payload,
    },
    db,
  );
}
