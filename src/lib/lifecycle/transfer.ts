import { z } from "zod";
import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { LifecycleDraftSchema, type LifecycleDraft } from "@/lib/types/lifecycle";
import { zodReason } from "@/lib/connect/protocol";
import { createLifecycleJourney, type ServiceResult } from "./service";
import { versionDocId } from "./enrol";
import type { GraphIssue } from "./graph";

/**
 * Moving a journey between products (connections) and accounts — the way a
 * customer promotes a journey from their staging product to their production
 * product, or reuses one elsewhere. Self-serve: nothing here needs platform
 * access.
 *
 * A journey document carries ONLY the design: graph, content pools and
 * settings. Never the tenant, the connection, test recipients, the shadow
 * inbox, caps, enrolments or any person's data. Importing always creates a
 * DRAFT on the chosen connection, validated against THAT product's catalog;
 * publishing (and the delivery mode) stay a human decision on the new journey.
 */

export const JOURNEY_DOCUMENT_FORMAT = "yougrow.lifecycle-journey";
export const JOURNEY_DOCUMENT_VERSION = 1;
/** Serialized documents above this are refused (a real journey is ~20–60 KB). */
export const MAX_JOURNEY_DOCUMENT_BYTES = 512 * 1024;

export const JourneyDocumentSchema = z.object({
  format: z.literal(JOURNEY_DOCUMENT_FORMAT),
  formatVersion: z.literal(JOURNEY_DOCUMENT_VERSION),
  exportedAt: z.string().max(40),
  name: z.string().trim().min(1).max(120),
  /** Which version was exported: a published version number, or null for the draft. */
  sourceVersion: z.number().int().positive().nullable(),
  draft: LifecycleDraftSchema,
});
export type JourneyDocument = z.infer<typeof JourneyDocumentSchema>;

export type ExportWhich = "published" | "draft";

/** The journey's design as a portable document. `published` falls back to the draft if never published. */
export async function exportJourneyDocument(
  ctx: TenantContext,
  journeyId: string,
  opts: { which?: ExportWhich; db?: FirestoreLike; nowMs?: number } = {},
): Promise<ServiceResult<JourneyDocument>> {
  const repo = forTenant(ctx, opts.db);
  const journey = await repo.lifecycleJourneys.getById(journeyId);
  if (!journey || journey.status === "archived") return { ok: false, status: 404, error: "not_found" };

  let draft: LifecycleDraft = journey.draft;
  let sourceVersion: number | null = null;
  if ((opts.which ?? "published") === "published" && journey.publishedVersion) {
    const version = await repo.lifecycleVersions.getById(versionDocId(journey.id, journey.publishedVersion));
    if (version) {
      draft = { graph: version.graph, pools: version.pools, settings: version.settings };
      sourceVersion = version.version;
    }
  }
  return {
    ok: true,
    value: {
      format: JOURNEY_DOCUMENT_FORMAT,
      formatVersion: JOURNEY_DOCUMENT_VERSION,
      exportedAt: new Date(opts.nowMs ?? Date.now()).toISOString(),
      name: journey.name,
      sourceVersion,
      // Re-parse so only schema fields travel, whatever else a stored doc holds.
      draft: LifecycleDraftSchema.parse(draft),
    },
  };
}

const ImportInput = z.object({
  connectionId: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(120).optional(),
  document: z.unknown(),
});

/** Create a DRAFT journey on `connectionId` from a journey document. */
export async function importJourneyDocument(
  ctx: TenantContext,
  input: unknown,
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<ServiceResult<{ journeyId: string; issues: GraphIssue[] }>> {
  const parsed = ImportInput.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400, error: "invalid_input", detail: zodReason(parsed.error) };
  if (JSON.stringify(parsed.data.document ?? null).length > MAX_JOURNEY_DOCUMENT_BYTES) {
    return { ok: false, status: 413, error: "document_too_large" };
  }
  const doc = JourneyDocumentSchema.safeParse(parsed.data.document);
  if (!doc.success) return { ok: false, status: 400, error: "invalid_document", detail: zodReason(doc.error) };

  const created = await createLifecycleJourney(
    ctx,
    { name: parsed.data.name ?? doc.data.name, connectionId: parsed.data.connectionId, template: "blank" },
    { db: deps.db, nowMs: deps.nowMs, authoredBy: "human", draft: doc.data.draft },
  );
  if (!created.ok) return created;
  return { ok: true, value: { journeyId: created.value.journey.id, issues: created.value.issues } };
}

const DuplicateInput = z.object({
  connectionId: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(120).optional(),
  which: z.enum(["published", "draft"]).default("published"),
});

/**
 * Copy a journey onto another product in the same account — e.g. from
 * "vizzybl.ai (staging)", where it was tested, to "vizzybl.ai (production)".
 */
export async function duplicateJourney(
  ctx: TenantContext,
  journeyId: string,
  input: unknown,
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<ServiceResult<{ journeyId: string; issues: GraphIssue[] }>> {
  const parsed = DuplicateInput.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400, error: "invalid_input", detail: zodReason(parsed.error) };
  const exported = await exportJourneyDocument(ctx, journeyId, { which: parsed.data.which, db: deps.db, nowMs: deps.nowMs });
  if (!exported.ok) return exported;
  return importJourneyDocument(
    ctx,
    { connectionId: parsed.data.connectionId, name: parsed.data.name ?? `${exported.value.name} (copy)`.slice(0, 120), document: exported.value },
    deps,
  );
}
