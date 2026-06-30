import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant, verifyOwner } from "@/lib/tenant";
import { KnowledgeChunkSource, KnowledgeOwnerKind } from "@/lib/types/knowledgeBase";
import { isContentMatrixTopic } from "@/lib/content/contentMatrix";
import { normalizeTags } from "@/lib/knowledge/tags";
import { enqueueIngestionTicket } from "@/lib/knowledge/tickets";
import { triggerIngestionJob, isIngestionJobConfigured } from "@/lib/knowledge/runJob";
import { validateIngestUrl } from "@/lib/knowledge/url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IngestSchema = z.object({
  ownerKind: KnowledgeOwnerKind,
  ownerId: z.string().min(1),
  source: KnowledgeChunkSource,
  sourceUri: z.string().url().max(2048),
  // git branch / tag / commit SHA — constrained charset, no leading '-'.
  ref: z
    .string()
    .max(255)
    .regex(/^(?!-)[A-Za-z0-9._/-]+$/, "invalid ref")
    .optional(),
  includeGlobs: z.array(z.string().max(255)).max(50).optional(),
  /** Content Matrix topic id (required). */
  topic: z.string().min(1),
  /** Free-form custom tags (aligned to the normalizer's caps: 20 × ≤40 chars). */
  tags: z.array(z.string().max(40)).max(20).optional(),
});

/**
 * Dispatch a knowledge-ingestion run for a polymorphic owner (campaign|workspace).
 * Validates input + topic + ownership, creates an idempotent ticket, and triggers
 * the scraper Cloud Run Job.
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
  const { ownerKind, ownerId, source, sourceUri, ref, includeGlobs, topic } = parsed.data;

  if (!isContentMatrixTopic(topic)) {
    return NextResponse.json({ error: "invalid_topic" }, { status: 400 });
  }
  const tags = normalizeTags(parsed.data.tags);

  const url = validateIngestUrl(sourceUri, source);
  if (!url.ok) {
    return NextResponse.json({ error: "invalid_source_url", reason: url.reason }, { status: 400 });
  }

  // Authorize: the owner must belong to this tenant (also authorizes the worker's
  // later writes into {owner}/{id}/knowledge_bases).
  if (!(await verifyOwner(ctx, ownerKind, ownerId))) {
    return NextResponse.json({ error: "owner_not_found" }, { status: 404 });
  }

  const enq = await enqueueIngestionTicket(ctx, {
    ownerKind,
    ownerId,
    source,
    sourceUri: url.url,
    ref: ref ?? null,
    includeGlobs: includeGlobs ?? null,
    topic,
    tags,
  });
  if (enq.status === "rate_limited") {
    return NextResponse.json({ error: "too_many_active_ingestions" }, { status: 429 });
  }
  if (enq.status === "duplicate") {
    return NextResponse.json({ ticketId: enq.ticketId, status: "duplicate" }, { status: 200 });
  }

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
      ownerKind,
      ownerId,
      region: ctx.region,
      source,
      sourceUri: url.url,
      ref: ref ?? null,
      includeGlobs: includeGlobs ?? null,
      topic,
      tags,
    });
  } catch (err) {
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
