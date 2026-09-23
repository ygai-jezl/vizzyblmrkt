import type { TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { RepoAnalysis } from "@/lib/types/repoAnalysis";
import { listRepoAnalyses, startRepoAnalysis } from "./repoAnalysis";

/**
 * "Learn from repo" for Vizzy (lifecycle_ops). Vizzy can START a read-only
 * analysis and READ a compact summary of what it found — items, whether each is
 * backed by verified code, gaps — but never code excerpts, and it can't accept
 * anything into the catalog: that's a person's decision on the review screen.
 */

type Result = { status: number; body: unknown };

const verified = (e: Array<{ verified: boolean }>) => e.some((x) => x.verified);

export function summariseAnalysis(a: RepoAnalysis, connectionId: string) {
  const m = a.map;
  return {
    id: a.id,
    status: a.status,
    repos: a.repos.map((r) => ({ url: r.url, ref: r.ref })),
    createdAt: a.createdAt,
    finishedAt: a.finishedAt ?? null,
    error: a.error ?? null,
    acceptedAt: a.acceptedAt ?? null,
    stats: a.stats ? { files: a.stats.files, items: a.stats.items, verifiedItems: a.stats.verifiedItems } : null,
    reviewUrl: `/admin/products/${connectionId}`,
    map: m
      ? {
          summary: m.summary,
          onboardingSteps: m.onboardingSteps.map((s) => ({ id: s.id, label: s.label, completion: s.completion, detection: s.detection, confidence: s.confidence, backedByCode: verified(s.evidence) })),
          events: m.events.map((e) => ({ name: e.name, when: e.when, confidence: e.confidence, backedByCode: verified(e.evidence) })),
          traits: m.traits.map((t) => ({ key: t.key, type: t.type, confidence: t.confidence, backedByCode: verified(t.evidence) })),
          facts: m.facts.map((f) => ({ id: f.id, label: f.label, unit: f.unit ?? null, source: f.source, confidence: f.confidence, backedByCode: verified(f.evidence) })),
          glossary: m.glossary.map((g) => g.term),
          hooks: m.hooks.map((h) => ({ kind: h.kind, description: h.description })),
          warnings: m.warnings,
        }
      : null,
  };
}

export async function agentGetRepoAnalysis(ctx: TenantContext, connectionId: string, db?: FirestoreLike): Promise<Result> {
  const [latest] = await listRepoAnalyses(ctx, connectionId, db);
  if (!latest) return { status: 200, body: { analysis: null, reviewUrl: `/admin/products/${connectionId}` } };
  return { status: 200, body: { analysis: summariseAnalysis(latest, connectionId) } };
}

export async function agentStartRepoAnalysis(ctx: TenantContext, connectionId: string, input: unknown, db?: FirestoreLike): Promise<Result> {
  const r = await startRepoAnalysis(ctx, connectionId, input, { db });
  if (!r.ok) return { status: r.status, body: { error: r.error, detail: r.detail } };
  return { status: 202, body: { analysis: summariseAnalysis(r.value.analysis, connectionId) } };
}
