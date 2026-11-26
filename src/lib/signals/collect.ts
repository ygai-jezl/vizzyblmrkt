import { randomUUID } from "node:crypto";
import { readBrandMap } from "@/lib/brandMap/store";
import { tenantMayUse } from "@/lib/plans/brandAccess";
import { monthlyLimit } from "@/lib/plans/limits";
import { usageMeter } from "@/lib/plans/meter";
import { getTenantById } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { BrandSignal } from "@/lib/types/brandSignal";
import type { Tenant } from "@/lib/types/tenant";
import { dataForSeoConfigured, getSerpTask, hostOf, parseSerp, postSerpTask, type DataForSeoDeps } from "./dataforseo";
import { isSignalsDataForSeoEnabled } from "./flags";
import { brandMarket } from "./markets";
import {
  claimSignal,
  finishSignal,
  isFresh,
  isPending,
  lookupsThisMonth,
  recordPosted,
  signalFor,
  signalIdFor,
  type SignalStoreDeps,
} from "./store";

/**
 * Looking a question up on Google and collecting what came back (SIGNALS_DATAFORSEO_ENABLED).
 * A lookup costs money, so it happens only for a brand with the `next_up` feature, under its
 * monthly cap, and a question looked up in the last 90 days is never looked up again.
 */

export interface CollectDeps extends SignalStoreDeps, DataForSeoDeps {
  loadTenant?: (id: string) => Promise<Tenant | null>;
  /** The brand's own site hosts; read from the brand map and the brand's origins when left out. */
  ownHosts?: string[];
}

/** Collect again this long after "not ready yet". */
const LOOK_AGAIN_MS = 20_000;

/** The brand's own site hosts (no "www."): its brand map site and the origins it embeds on. */
export async function ownHostsOf(ctx: TenantContext, tenant: Pick<Tenant, "allowedOrigins"> | null, deps: CollectDeps = {}): Promise<string[]> {
  if (deps.ownHosts) return deps.ownHosts;
  const read = await readBrandMap(ctx, deps.db).catch(() => null);
  const site = read?.state === "ok" ? read.map.identity.site : "";
  const hosts = [site, ...(tenant?.allowedOrigins ?? [])].map((u) => hostOf(u)).filter((h) => h && h !== "localhost" && h.includes("."));
  return [...new Set(hosts)];
}

/** Collect one lookup: ready, failed, not ready yet, or held by another run. */
export async function collectSignal(
  ctx: TenantContext,
  signal: BrandSignal,
  own: string[],
  deps: CollectDeps = {},
): Promise<"ready" | "failed" | "not_yet" | "busy"> {
  if (!signal.taskId) return "failed";
  const leaseId = randomUUID();
  const mine = await claimSignal(ctx, signal.id, leaseId, deps);
  if (!mine) return "busy";
  const got = await getSerpTask(signal.taskId, deps);
  if (got.ok) {
    const { numbers, results } = parseSerp(got.raw, own);
    await finishSignal(ctx, signal.id, leaseId, { status: "ready", numbers, results, cost: got.cost }, deps);
    return "ready";
  }
  if (got.notReady || got.error === "timeout" || got.error === "network") {
    const after = await finishSignal(ctx, signal.id, leaseId, { status: "not_yet", nextLookMs: LOOK_AGAIN_MS }, deps);
    return after?.status === "failed" ? "failed" : "not_yet";
  }
  await finishSignal(ctx, signal.id, leaseId, { status: "failed", error: got.error }, deps);
  return "failed";
}

/** purpose: who asked, for the usage meter (a person's "Get from Google", the autopilot, or Make the plan). Default: a person. */
export type LookupAsk = { query: string; questionId: string | null; subjectId: string | null; purpose?: "get_from_google" | "autopilot" | "content_strategy" };

export type LookupOutcome =
  | { ok: true; signal: BrandSignal; reused: boolean }
  | { ok: false; status: number; error: "unavailable" | "not_set_up" | "not_included" | "monthly_limit" | "lookup_failed"; detail?: string };

/**
 * Look a question up for a person waiting: the stored lookup when it is fresh or on its way,
 * otherwise a new one (high priority), within the brand's grant and monthly cap.
 */
export async function lookUpQuestion(ctx: TenantContext, ask: LookupAsk, deps: CollectDeps = {}): Promise<LookupOutcome> {
  if (!isSignalsDataForSeoEnabled()) return { ok: false, status: 503, error: "unavailable" };
  if (!dataForSeoConfigured(deps.env ?? process.env)) return { ok: false, status: 503, error: "not_set_up" };
  const tenant = await (deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => null);
  if (!tenantMayUse(tenant, "next_up")) return { ok: false, status: 403, error: "not_included" };
  const market = brandMarket(tenant?.searchMarket);
  const now = (deps.now ?? (() => new Date()))();

  const stored = await signalFor(ctx, ask.query, market, deps);
  if (stored && (isFresh(stored, now) || isPending(stored, now))) return { ok: true, signal: stored, reused: true };

  if ((await lookupsThisMonth(ctx, deps)) >= monthlyLimit(tenant, "next_up")) return { ok: false, status: 429, error: "monthly_limit" };

  const posted = await postSerpTask(ask.query, market, { tag: signalIdFor(ctx.tenantId, ask.query, market), priority: 2 }, deps);
  if (!posted.ok) return { ok: false, status: 502, error: "lookup_failed", detail: posted.error };
  // A posted task is billed: it goes on the usage meter (a reused lookup above isn't).
  const { purpose = "get_from_google", ...lookup } = ask;
  await usageMeter(ctx, "google_lookups", purpose, { db: deps.db, now: deps.now, tenant }).record(1);
  const signal = await recordPosted(ctx, { ...lookup, market, askedBy: "person", taskId: posted.taskId, cost: posted.cost }, deps);
  return { ok: true, signal, reused: false };
}
