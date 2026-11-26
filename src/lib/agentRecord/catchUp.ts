import { createHash } from "node:crypto";
import { forTenant, getTenantById, listAllTenants, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { pageAgentActions } from "@/lib/ontology/agentActions";
import { readMap } from "@/lib/connect/repoAnalysis";
import type { AgentAction } from "@/lib/types/agentAction";
import type { Tenant } from "@/lib/types/tenant";
import { isAgentRecordEnabled } from "./flags";
import { closeMapRun, readMapLists, type MapLists } from "./mapRuns";
import { actAsSystem, closeAsSystem, styleRecordId } from "./record";
import { SOURCES, type CatchUpReader, type SourceLine } from "./sources";

/**
 * Agent record (ADR-0026), the daily catch-up: a lazily loaded job in the lifecycle tick, behind
 * AGENT_RECORD_ENABLED, once a day per brand in the 2 minute slot its id falls in. For each action
 * it pages the open records (equality only), reads each draft by id, and closes what moved on
 * another way:
 * - gone, or in an archived programme: stale;
 * - published by the engine switch, or a piece approved by Found live: acted, by the system;
 * - a brand map run with none of its keys still waiting: acted if any were accepted, dismissed if
 *   all went to the map's dismissed list (mapRuns.ts);
 * - a learning run that failed or found nothing: stale;
 * - past its expiry: expired, checked in memory, so it also works where person links are off.
 * Nobody deciding is never a no: stale and expired are the system's.
 */

export const CATCH_UP = {
  TICK_MS: 120_000,
  /** 2 minute slots in a day. */
  SLOTS: 720,
  PAGE: 50,
  /** Pages of one action read for a brand, at most. */
  PAGES: 4,
  /** No brand starts with less than this left. */
  MIN_LEFT_MS: 3_000,
} as const;

/** The slot a brand's id falls in, 0 to 719. */
export function slotOf(tenantId: string): number {
  return parseInt(createHash("sha256").update(`agent-record\n${tenantId}`).digest("hex").slice(0, 8), 16) % CATCH_UP.SLOTS;
}

/** True during the brand's own 2 minute slot of the day. */
export function inSlot(tenantId: string, nowMs: number): boolean {
  return Math.floor(nowMs / CATCH_UP.TICK_MS) % CATCH_UP.SLOTS === slotOf(tenantId);
}

export interface CatchUpDeps {
  db?: FirestoreLike;
  /** A region's database (tests pass one fake for all). */
  regionDb?: (region: Tenant["region"]) => FirestoreLike | undefined;
  listTenants?: () => Promise<Tenant[]>;
  now?: () => number;
}

export interface CatchUpResult {
  brands: number;
  read: number;
  closed: number;
}

/** What the readers share for one brand: each read at most once. */
interface BrandReads {
  tenant?: Promise<Tenant | null>;
  lists?: Promise<MapLists | null>;
}

type Verdict = { to: "acted" } | { to: "stale" } | { to: "map" } | null;

const STEP_SECTIONS = ["onboardingSteps", "events", "traits", "facts", "glossary"] as const;

/** One record's draft, read by id: what happened to it. Null while it still waits. */
async function verdictOf(ctx: TenantContext, a: AgentAction, reader: CatchUpReader, reads: BrandReads, db?: FirestoreLike): Promise<Verdict> {
  const ref = a.draft?.ref;
  if (!ref) return { to: "stale" };
  const repos = forTenant(ctx, db);
  switch (reader) {
    case "launch_journey":
    case "lifecycle_journey": {
      if (a.draft?.kind === "launch_journey") {
        const j = await repos.journeys.getById(ref);
        if (!j || j.retiredAt) return { to: "stale" };
        return j.status === "draft" ? null : { to: "acted" };
      }
      const j = await repos.lifecycleJourneys.getById(ref);
      if (!j || j.status === "archived") return { to: "stale" };
      if (j.publishedVersion == null) return null;
      const v = await repos.lifecycleVersions.getById(`${j.id}_v${j.publishedVersion}`);
      // Published since Vizzy saved it, and not through the editor's Publish: the engine switch.
      return v && v.publishedAt > a.createdAt ? { to: "acted" } : null;
    }
    case "invite_wave": {
      const w = await repos.inviteWaves.getById(ref);
      if (!w || w.status === "cancelled") return { to: "stale" };
      return w.status === "draft" ? null : { to: "acted" };
    }
    case "content_plan": {
      const [workspaceId, planId] = ref.split(":");
      if (!workspaceId || !planId) return { to: "stale" };
      const ws = await repos.workspaces.getById(workspaceId);
      if (!ws || ws.archivedAt) return { to: "stale" };
      const plan = await getContentPlan(ctx, workspaceId, planId, db);
      if (!plan || plan.status === "archived") return { to: "stale" };
      // A piece approved since (Found live approves an article it finds live), or scheduled.
      return plan.status === "scheduled" || plan.graph.nodes.some((n) => n.status === "approved") ? { to: "acted" } : null;
    }
    case "brand_style": {
      reads.tenant ??= getTenantById(ctx.tenantId, db).catch(() => null);
      const t = await reads.tenant;
      if (!t) return null;
      const s = a.action === "email_style.suggest" ? t.emailStyleSuggestion : t.imageStyleSuggestion;
      const action = a.action === "email_style.suggest" ? "email_style.suggest" : "image_style.suggest";
      // Still this suggestion: it waits. Gone or replaced with no record of it: stale.
      return s && styleRecordId(ctx.tenantId, action, s.suggestedAt) === a.id ? null : { to: "stale" };
    }
    case "brand_note": {
      const note = await repos.brandNotes.getById(ref);
      if (!note) return { to: "stale" };
      return note.status === "suggested" ? null : { to: "acted" };
    }
    case "repo_run": {
      const run = typeof a.proposal?.run === "string" ? a.proposal.run : null;
      const analysis = run ? await repos.repoAnalyses.getById(run) : null;
      if (!analysis || analysis.status === "failed") return { to: "stale" };
      if (analysis.acceptedAt) return { to: "acted" };
      if (analysis.status !== "done" && analysis.status !== "incomplete") return null;
      const map = readMap(analysis);
      const found = map ? STEP_SECTIONS.reduce((n, k) => n + map[k].length, 0) : 0;
      return found ? null : { to: "stale" };
    }
    case "brand_map_run":
      return { to: "map" };
  }
}

/** One brand's open records, closed where their drafts moved on. */
export async function catchUpBrand(ctx: TenantContext, opts: { deadlineMs: number; db?: FirestoreLike; now?: () => number }): Promise<{ read: number; closed: number }> {
  const now = opts.now ?? Date.now;
  const out = { read: 0, closed: 0 };
  const reads: BrandReads = {};
  const deps = { db: opts.db, nowMs: now() };
  const at = new Date(deps.nowMs).toISOString();
  for (const line of SOURCES as readonly SourceLine[]) {
    let after: string | null = null;
    for (let page = 0; page < CATCH_UP.PAGES; page++) {
      if (now() >= opts.deadlineMs) return out;
      const r = await pageAgentActions(ctx, { action: line.action, state: "proposed" }, { after, limit: CATCH_UP.PAGE, db: opts.db });
      for (const a of r.actions) {
        if (now() >= opts.deadlineMs) return out;
        out.read += 1;
        try {
          if (a.expiresAt <= at) {
            if (await closeAsSystem(ctx, a, "expired", deps)) out.closed += 1;
            continue;
          }
          const v = await verdictOf(ctx, a, line.catchUp, reads, opts.db);
          if (!v) continue;
          if (v.to === "map") {
            reads.lists ??= readMapLists(ctx, opts.db).catch(() => null);
            const lists = await reads.lists;
            if (lists && (await closeMapRun(ctx, a, lists, deps))) out.closed += 1;
          } else if (v.to === "acted") {
            if (await actAsSystem(ctx, a, null, deps)) out.closed += 1;
          } else if (await closeAsSystem(ctx, a, "stale", deps)) out.closed += 1;
        } catch (err) {
          console.warn(`[agent-record] catch-up ${a.action} failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
        }
      }
      if (!r.more) break;
      after = r.last;
    }
  }
  return out;
}

/**
 * The tick's lane: the brands whose slot this is, each once a day, within the budget. Off, it
 * does nothing (records still close where people decide, and the lifecycle tick expires them).
 */
export async function runAgentRecordCatchUp(opts: { deadlineMs: number }, deps: CatchUpDeps = {}): Promise<CatchUpResult> {
  const result: CatchUpResult = { brands: 0, read: 0, closed: 0 };
  if (!isAgentRecordEnabled()) return result;
  const now = deps.now ?? Date.now;
  const tenants = await (deps.listTenants ?? listAllTenants)();
  for (const t of tenants) {
    if (opts.deadlineMs - now() < CATCH_UP.MIN_LEFT_MS) break;
    if (t.status === "suspended" || !inSlot(t.id, now())) continue;
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    try {
      result.brands += 1;
      const r = await catchUpBrand(ctx, { deadlineMs: opts.deadlineMs, db: deps.regionDb?.(t.region) ?? deps.db, now });
      result.read += r.read;
      result.closed += r.closed;
    } catch (err) {
      console.warn(`[agent-record] catch-up for ${t.id} failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  return result;
}
