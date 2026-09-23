import { randomBytes } from "node:crypto";
import { z } from "zod";
import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { isRateLimited } from "@/lib/tenant/rateLimit";
import { validateIngestUrl } from "@/lib/knowledge/url";
import { ConnectionCatalogSchema, type ConnectionCatalog, type ProductConnection } from "@/lib/types/productConnection";
import type { AnalysisRepo, RepoAnalysis } from "@/lib/types/repoAnalysis";
import { ProductMapSchema, type ProductMap } from "./productMapSchema";
import { zodReason } from "./protocol";

/**
 * "Learn from your repo": propose a connection's catalog (onboarding steps and
 * how each completes, events, traits, facts, glossary) from the customer's own
 * code. Repos are READ ONLY — we clone, read and discard; we never write to them.
 * The analysis runs in the knowledge-scraper Job (JOB_KIND=product_map); here we
 * start runs, re-validate what the Job wrote, and turn the items a person
 * accepts into catalog entries.
 */

export type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string; detail?: unknown };
const fail = (status: number, error: string, detail?: unknown): Result<never> => ({ ok: false, status, error, detail });

export const MAX_REPOS = 3;
/** Beta cap per account per UTC day (each run is a few hundred thousand model tokens). */
export const ANALYSES_PER_DAY = 10;

export function newAnalysisId(): string {
  return `ra_${randomBytes(12).toString("hex")}`;
}

const RepoInput = z.object({
  url: z.string().trim().min(1).max(2048),
  ref: z
    .string()
    .trim()
    .max(255)
    .regex(/^(?!-)[A-Za-z0-9._/-]+$/, "invalid branch")
    .optional()
    .nullable(),
});
const StartInput = z.object({ repos: z.array(RepoInput).min(1).max(MAX_REPOS) });

/** github.com/acme/web(.git) → { provider, url, label: "web" }. */
export function parseRepoUrl(raw: string): { provider: "github" | "gitlab"; url: string; label: string } | null {
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
  let host: string;
  try {
    host = new URL(withScheme).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  const provider = host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : null;
  if (!provider) return null;
  const v = validateIngestUrl(withScheme, provider);
  if (!v.ok) return null;
  const u = new URL(v.url);
  const parts = u.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length < 2 || parts.some((p) => !/^[A-Za-z0-9._-]+$/.test(p))) return null;
  u.pathname = `/${parts.join("/")}`;
  u.search = "";
  u.hash = "";
  return { provider, url: u.toString(), label: parts[parts.length - 1]!.toLowerCase().slice(0, 40) };
}

export interface StartDeps {
  db?: FirestoreLike;
  nowMs?: number;
  /** Dispatches the Job (tests inject a stub). */
  trigger?: (vars: { analysisId: string; tenantId: string; region: TenantContext["region"] }) => Promise<void>;
}

export async function startRepoAnalysis(
  ctx: TenantContext,
  connectionId: string,
  input: unknown,
  deps: StartDeps = {},
): Promise<Result<{ analysis: RepoAnalysis }>> {
  const parsed = StartInput.safeParse(input);
  if (!parsed.success) return fail(400, "invalid_input", zodReason(parsed.error));
  const repo = forTenant(ctx, deps.db);
  const conn = await repo.productConnections.getById(connectionId);
  if (!conn || conn.status === "revoked") return fail(404, "not_found");

  const repos: AnalysisRepo[] = [];
  const labels = new Set<string>();
  for (const r of parsed.data.repos) {
    const p = parseRepoUrl(r.url);
    if (!p) return fail(400, "invalid_repo_url", r.url.slice(0, 200));
    let label = p.label;
    for (let i = 2; labels.has(label); i += 1) label = `${p.label}-${i}`;
    labels.add(label);
    repos.push({ provider: p.provider, url: p.url, ref: r.ref ?? null, label });
  }

  const nowMs = deps.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const dayStart = new Date(Math.floor(nowMs / 86_400_000) * 86_400_000).toISOString();
  const recent = await repo.repoAnalyses.find({ where: [["createdAt", ">=", dayStart]], limit: ANALYSES_PER_DAY + 1 });
  if (recent.length >= ANALYSES_PER_DAY) return fail(429, "analysis_daily_cap");
  if (recent.some((a) => a.connectionId === connectionId && (a.status === "queued" || a.status === "running"))) {
    return fail(409, "analysis_in_progress");
  }
  if (await isRateLimited(`${ctx.tenantId}`, { prefix: "repo_analysis", burstLimit: 2, hourlyLimit: 6 }, { db: deps.db, now: nowMs })) {
    return fail(429, "rate_limited");
  }

  const id = newAnalysisId();
  const analysis = await repo.repoAnalyses.create(id, {
    connectionId,
    productName: conn.name,
    repos,
    status: "queued",
    map: null,
    stats: null,
    error: null,
    createdAt: now,
    createdBy: ctx.email ?? ctx.userId ?? null,
  });
  try {
    await (deps.trigger ?? defaultTrigger)({ analysisId: id, tenantId: ctx.tenantId, region: ctx.region });
  } catch (err) {
    const error = err instanceof Error && err.message === "product_map_job_not_configured" ? "job_not_configured" : "job_dispatch_failed";
    await repo.repoAnalyses.update(id, { status: "failed", error, finishedAt: now });
    return fail(503, error);
  }
  return { ok: true, value: { analysis } };
}

async function defaultTrigger(vars: { analysisId: string; tenantId: string; region: TenantContext["region"] }): Promise<void> {
  const { triggerProductMapJob } = await import("@/lib/knowledge/runJob");
  await triggerProductMapJob(vars);
}

/** The Job's output re-validated; a map that doesn't parse is treated as missing. */
export function readMap(a: Pick<RepoAnalysis, "map">): ProductMap | null {
  if (!a.map) return null;
  const r = ProductMapSchema.safeParse(a.map);
  return r.success ? r.data : null;
}

export async function listRepoAnalyses(
  ctx: TenantContext,
  connectionId: string,
  db?: FirestoreLike,
): Promise<RepoAnalysis[]> {
  const rows = await forTenant(ctx, db).repoAnalyses.find({ where: [["connectionId", "==", connectionId]], limit: 20 });
  return rows
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5)
    .map((a) => ({ ...a, map: readMap(a) }));
}

// ---- Accepting items into the catalog ----------------------------------------

const AcceptInput = z.object({
  steps: z.array(z.string().max(64)).max(20).default([]),
  events: z.array(z.string().max(80)).max(40).default([]),
  traits: z.array(z.string().max(64)).max(40).default([]),
  facts: z.array(z.string().max(64)).max(30).default([]),
  glossary: z.array(z.string().max(80)).max(40).default([]),
  /** The product's web origin, e.g. https://app.acme.com — turns step paths into deep links. */
  appOrigin: z.string().trim().max(200).nullable().optional(),
});

/** Merge `incoming` into `list`, replacing items with the same key and appending the rest. */
function upsert<T>(list: T[], incoming: T[], key: (t: T) => string): T[] {
  const byKey = new Map(incoming.map((t) => [key(t), t]));
  const out = list.map((t) => byKey.get(key(t)) ?? t);
  const have = new Set(list.map(key));
  for (const t of incoming) if (!have.has(key(t))) out.push(t);
  return out;
}

function deepLink(origin: URL | null, path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^https:\/\//i.test(path)) return path.slice(0, 2000);
  if (!origin || !path.startsWith("/")) return null;
  return new URL(path, origin).toString().slice(0, 2000);
}

export async function acceptProductMap(
  ctx: TenantContext,
  connectionId: string,
  analysisId: string,
  input: unknown,
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<Result<{ catalog: ConnectionCatalog; linkDomains: string[]; accepted: NonNullable<RepoAnalysis["accepted"]> }>> {
  const parsed = AcceptInput.safeParse(input ?? {});
  if (!parsed.success) return fail(400, "invalid_input", zodReason(parsed.error));
  const repo = forTenant(ctx, deps.db);
  const [conn, analysis] = await Promise.all([
    repo.productConnections.getById(connectionId),
    repo.repoAnalyses.getById(analysisId),
  ]);
  if (!conn || conn.status === "revoked" || !analysis || analysis.connectionId !== connectionId) return fail(404, "not_found");
  const map = readMap(analysis);
  if (!map) return fail(409, "no_map");

  let origin: URL | null = null;
  if (parsed.data.appOrigin) {
    try {
      origin = new URL(parsed.data.appOrigin);
    } catch {
      return fail(400, "invalid_app_origin");
    }
    if (origin.protocol !== "https:") return fail(400, "invalid_app_origin");
  }

  const pick = <T>(items: T[], keys: string[], key: (t: T) => string) => items.filter((i) => keys.includes(key(i)));
  const steps = pick(map.onboardingSteps, parsed.data.steps, (s) => s.id);
  const events = pick(map.events, parsed.data.events, (e) => e.name);
  const traits = pick(map.traits, parsed.data.traits, (t) => t.key);
  const facts = pick(map.facts, parsed.data.facts, (f) => f.id);
  const glossary = pick(map.glossary, parsed.data.glossary, (g) => g.term);

  const current = ConnectionCatalogSchema.parse(conn.catalog ?? {});
  const sortedSteps = [...current.onboardingSteps].sort((a, b) => a.order - b.order);
  const mergedSteps = upsert(
    sortedSteps,
    steps.map((s) => ({ id: s.id, label: s.label, url: deepLink(origin, s.path), order: 0, completion: s.completion || undefined })),
    (s) => s.id,
  ).map((s, i) => ({ ...s, order: i }));

  const next = ConnectionCatalogSchema.safeParse({
    ...current,
    onboardingSteps: mergedSteps,
    events: upsert(current.events, events.map((e) => ({ name: e.name, label: e.label, description: [e.description, e.when].filter(Boolean).join(" — ").slice(0, 500) })), (e) => e.name),
    traits: upsert(current.traits, traits.map((t) => ({ key: t.key, type: t.type, label: t.label, description: t.description })), (t) => t.key),
    facts: upsert(current.facts, facts.map((f) => ({ id: f.id, label: f.label, type: f.type, unit: f.unit ?? null, description: f.description, source: f.source })), (f) => f.id),
    glossary: upsert(current.glossary, glossary.map((g) => ({ term: g.term, definition: g.definition })), (g) => g.term.toLowerCase()),
  });
  if (!next.success) return fail(422, "catalog_invalid", zodReason(next.error));

  // Deep links into the product are allowed only on its link domains: add the app's.
  const linkDomains = origin && !conn.linkDomains.includes(origin.hostname) ? [...conn.linkDomains, origin.hostname].slice(0, 20) : conn.linkDomains;
  const nowIso = new Date(deps.nowMs ?? Date.now()).toISOString();
  const accepted = { steps: steps.length, events: events.length, traits: traits.length, facts: facts.length, glossary: glossary.length };
  await repo.productConnections.update(connectionId, { catalog: next.data, linkDomains, updatedAt: nowIso } as Partial<ProductConnection>);
  await repo.repoAnalyses.update(analysisId, { acceptedAt: nowIso, acceptedBy: ctx.email ?? ctx.userId ?? null, accepted });
  return { ok: true, value: { catalog: next.data, linkDomains, accepted } };
}
