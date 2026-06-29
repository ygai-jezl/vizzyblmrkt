import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { KnowledgeChunkSource } from "@/lib/types/knowledgeBase";
import { enqueueIngestionTicket } from "@/lib/knowledge/tickets";
import { triggerIngestionJob, isIngestionJobConfigured } from "@/lib/knowledge/runJob";
import { validateIngestUrl } from "@/lib/knowledge/url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IngestSchema = z.object({
  campaignId: z.string().min(1),
  source: KnowledgeChunkSource,
  sourceUri: z.string().url().max(2048),
  // A git branch / tag / commit SHA. Constrain the charset (and forbid a leading
  // '-') so an operator value can never be mis-parsed as a `git clone` option.
  ref: z
    .string()
    .max(255)
    .regex(/^(?!-)[A-Za-z0-9._/-]+$/, "invalid ref")
    .optional(),
  includeGlobs: z.array(z.string().max(255)).max(50).optional(),
});

/**
 * Dispatch a knowledge-ingestion run: validate input, verify campaign ownership,
 * create an idempotent ticket, and trigger the containerised scraper Cloud Run
 * Job. The heavy work (clone/scrape/chunk/embed) happens off-request in the Job.
 */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = IngestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const { campaignId, source, sourceUri, ref, includeGlobs } = parsed.data;

  // SSRF front door + per-source host pinning (worker re-checks at fetch time).
  const url = validateIngestUrl(sourceUri, source);
  if (!url.ok) {
    return NextResponse.json({ error: "invalid_source_url", reason: url.reason }, { status: 400 });
  }

  // Authorize: the campaign must belong to this tenant (this gate also authorizes
  // the worker's later writes into campaigns/{id}/knowledge_bases).
  const campaign = await forTenant(ctx).campaigns.getById(campaignId);
  if (!campaign) {
    return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });
  }

  const enq = await enqueueIngestionTicket(ctx, {
    campaignId,
    source,
    sourceUri: url.url,
    ref: ref ?? null,
    includeGlobs: includeGlobs ?? null,
  });
  if (enq.status === "rate_limited") {
    return NextResponse.json({ error: "too_many_active_ingestions" }, { status: 429 });
  }
  if (enq.status === "duplicate") {
    // Already queued/running — return the existing ticket, don't double-trigger.
    return NextResponse.json({ ticketId: enq.ticketId, status: "duplicate" }, { status: 200 });
  }

  // Trigger the worker. If the Job isn't provisioned in this env (e.g. local dev),
  // leave the ticket pending rather than failing the request.
  if (!isIngestionJobConfigured()) {
    return NextResponse.json(
      { ticketId: enq.ticketId, status: "pending", jobTriggered: false },
      { status: 202 },
    );
  }
  try {
    await triggerIngestionJob({
      ticketId: enq.ticketId,
      tenantId: ctx.tenantId,
      campaignId,
      region: ctx.region,
      source,
      sourceUri: url.url,
      ref: ref ?? null,
      includeGlobs: includeGlobs ?? null,
    });
  } catch (err) {
    // Couldn't start the worker — fail the ticket so it isn't orphaned pending.
    await forTenant(ctx)
      .ingestionTickets.update(enq.ticketId, {
        status: "failed",
        lastError: `job_trigger_failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`,
        finishedAt: new Date().toISOString(),
      })
      .catch(() => {});
    return NextResponse.json({ error: "job_trigger_failed", ticketId: enq.ticketId }, { status: 502 });
  }

  return NextResponse.json(
    { ticketId: enq.ticketId, status: "pending", jobTriggered: true },
    { status: 202 },
  );
}
