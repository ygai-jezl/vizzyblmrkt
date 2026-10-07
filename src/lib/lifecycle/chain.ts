import { z } from "zod";
import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { ConsentPolicy } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import {
  continuesFromId,
  isWaitlistJourney,
  JOURNEY_COMPLETED_EVENT,
  type LifecycleJourney,
  type LifecycleVersion,
} from "@/lib/types/lifecycle";
import { zodReason } from "@/lib/connect/protocol";
import { enrolPerson, versionDocId } from "./enrol";

/**
 * Journeys that CONTINUE FROM another journey (LIFECYCLE_JOURNEY_LINKS_ENABLED).
 *
 * The link is ONE setting, on the journey that follows: its "Starts when" names
 * the journey before it (`trigger.afterJourneyId`). Like every trigger it's
 * edited in the draft and goes live on publish — so the journey before never
 * needs republishing, and people already part-way through it carry on into the
 * next one. The end of the earlier journey shows the same link and can set it
 * (`linkNextJourney`), which edits the later journey's draft.
 *
 * At run time, when someone reaches the END of a journey (not when they're
 * stopped: unsubscribed, timed out, removed), the runner enrols them in every
 * active journey whose published trigger names it. The new journey's clock
 * starts at that moment. Each person still enters a journey once, so a loop of
 * journeys can't send anyone round twice.
 */

/** The part of a journey's settings that says what it continues from. */
type TriggerSettings = { trigger: { event: string; afterJourneyId?: string | null } };

/** Why a journey can't continue from the one it names. */
export type UpstreamProblem = "not_found" | "self" | "other_product" | "loop";

const MAX_CHAIN = 10;

/**
 * The journey `settings` continue from, checked: it exists, isn't this journey,
 * is on the same product, and doesn't lead back here. Null when a product event
 * starts the journey, or no journey is chosen yet (the validator reports that).
 */
export async function resolveUpstream(
  ctx: TenantContext,
  journey: { id: string | null; connectionId: string },
  settings: TriggerSettings,
  db?: FirestoreLike,
): Promise<{ journey: LifecycleJourney | null; problem: UpstreamProblem | null } | null> {
  const upstreamId = continuesFromId(settings);
  if (!upstreamId) return null;
  if (upstreamId === journey.id) return { journey: null, problem: "self" };
  const repo = forTenant(ctx, db);
  const upstream = await repo.lifecycleJourneys.getById(upstreamId);
  if (!upstream || upstream.status === "archived") return { journey: null, problem: "not_found" };
  if (isWaitlistJourney(upstream) || upstream.connectionId !== journey.connectionId) return { journey: upstream, problem: "other_product" };
  // Follow the chain back (by each draft's trigger): it mustn't come round to this journey.
  let at: LifecycleJourney | null = upstream;
  for (let hop = 0; at && journey.id && hop < MAX_CHAIN; hop += 1) {
    const before: string | null = continuesFromId(at.draft.settings);
    if (!before) break;
    if (before === journey.id) return { journey: upstream, problem: "loop" };
    at = await repo.lifecycleJourneys.getById(before);
  }
  return { journey: upstream, problem: null };
}

/** The validator's `upstream` option for a journey's draft. */
export async function upstreamCheck(
  ctx: TenantContext,
  journey: { id: string | null; connectionId: string },
  settings: TriggerSettings,
  db?: FirestoreLike,
): Promise<"ok" | UpstreamProblem | undefined> {
  const r = await resolveUpstream(ctx, journey, settings, db);
  return r ? (r.problem ?? "ok") : undefined;
}

export interface Follower {
  journey: LifecycleJourney;
  version: LifecycleVersion;
}

/**
 * The active journeys that start when someone finishes `journey`, each with its
 * published version. Found by the journey's `continuesFrom` (written on publish),
 * then confirmed against the version's own trigger.
 */
export async function followersOf(
  ctx: TenantContext,
  journey: Pick<LifecycleJourney, "id" | "connectionId">,
  db?: FirestoreLike,
): Promise<Follower[]> {
  const repo = forTenant(ctx, db);
  const active = await repo.lifecycleJourneys.find({
    where: [
      ["connectionId", "==", journey.connectionId],
      ["status", "==", "active"],
    ],
    limit: 50,
  });
  const out: Follower[] = [];
  for (const next of active) {
    if (next.id === journey.id || next.continuesFrom !== journey.id || !next.publishedVersion) continue;
    const version = await repo.lifecycleVersions.getById(versionDocId(next.id, next.publishedVersion));
    if (version && continuesFromId(version.settings) === journey.id) out.push({ journey: next, version });
  }
  return out;
}

export interface Handover {
  journeyId: string;
  name: string;
  outcome: "enrolled" | "duplicate" | "skipped";
  reason?: string;
}

/**
 * Hand someone who just finished `from` on to the journeys that continue from
 * it. Enrolment is idempotent (one per journey and person), so running it again
 * after a failed run enrols nobody twice. The usual entry rules apply to each
 * journey: its delivery mode, consent, exclusions and daily cap.
 */
export async function continueToNextJourneys(
  ctx: TenantContext,
  a: {
    from: Pick<LifecycleJourney, "id" | "connectionId">;
    /** The person as stored (not viewed through an entity). */
    user: ProductUser;
    /** The entity the finished enrolment was about, for a next journey about each or "the trigger's". */
    entityId?: string | null;
    consentPolicy?: ConsentPolicy;
    followers?: Follower[];
  },
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<Handover[]> {
  const nowMs = deps.nowMs ?? Date.now();
  const followers = a.followers ?? (await followersOf(ctx, a.from, deps.db));
  const out: Handover[] = [];
  for (const { journey, version } of followers) {
    const rs = await enrolPerson(
      ctx,
      {
        journey,
        version,
        user: a.user,
        source: "trigger",
        anchorAt: new Date(nowMs).toISOString(),
        consentPolicy: a.consentPolicy,
        triggerEntityId: a.entityId ?? null,
        fromJourneyId: a.from.id,
      },
      { db: deps.db, nowMs },
    );
    const best = rs.find((r) => r.outcome === "enrolled") ?? rs.find((r) => r.outcome === "duplicate") ?? rs[0];
    out.push({
      journeyId: journey.id,
      name: journey.name,
      outcome: best?.outcome ?? "skipped",
      ...(best?.outcome === "skipped" ? { reason: best.reason } : !best ? { reason: "no_entities" } : {}),
    });
  }
  return out;
}

/** A journey's design as it runs: its published version, or its draft before it's ever published. */
export type RunningDesign = Pick<LifecycleVersion, "graph" | "pools" | "settings">;

const MAX_PREVIEW_CHAIN = 5;

/**
 * The journeys someone goes through BEFORE `journey`, first one first — each
 * as it runs today (its published version, else its draft). `journey` itself is
 * read from its draft: that's what a preview shows. Stops at anything it can't
 * follow (a missing journey, another product's, a loop).
 */
export async function journeysBefore(
  ctx: TenantContext,
  journey: Pick<LifecycleJourney, "id" | "connectionId" | "draft">,
  db?: FirestoreLike,
): Promise<Array<{ journey: LifecycleJourney; design: RunningDesign }>> {
  const repo = forTenant(ctx, db);
  const out: Array<{ journey: LifecycleJourney; design: RunningDesign }> = [];
  const seen = new Set<string>([journey.id]);
  let beforeId = continuesFromId(journey.draft.settings);
  while (beforeId && !seen.has(beforeId) && out.length < MAX_PREVIEW_CHAIN) {
    seen.add(beforeId);
    const up = await repo.lifecycleJourneys.getById(beforeId);
    if (!up || up.status === "archived" || isWaitlistJourney(up) || up.connectionId !== journey.connectionId) break;
    const version = up.publishedVersion ? await repo.lifecycleVersions.getById(versionDocId(up.id, up.publishedVersion)) : null;
    const design: RunningDesign = version ?? up.draft;
    out.unshift({ journey: up, design });
    beforeId = continuesFromId(design.settings);
  }
  return out;
}

/** How the journeys on one product link to `journey`: what the editor's start and end show. */
export interface ChainView {
  /** The journey its draft continues from, and whether that's live yet (its published version names it too). */
  from: { id: string; name: string | null; problem: UpstreamProblem | null; live: boolean } | null;
  /** The journeys that continue from it: `live` = published and active; `draft` = set in the draft. */
  next: Array<{ id: string; name: string; status: LifecycleJourney["status"]; live: boolean; published: boolean; draft: boolean }>;
}

/** `others`: the product's other journeys (not archived). */
export function chainView(journey: LifecycleJourney, others: LifecycleJourney[], problem: UpstreamProblem | null): ChainView {
  const fromId = continuesFromId(journey.draft.settings);
  const next = others
    .filter((o) => o.id !== journey.id)
    .map((o) => ({
      id: o.id,
      name: o.name,
      status: o.status,
      published: o.continuesFrom === journey.id && Boolean(o.publishedVersion),
      draft: continuesFromId(o.draft.settings) === journey.id,
    }))
    .filter((o) => o.published || o.draft)
    .map((o) => ({ ...o, live: o.published && o.status === "active" }));
  return {
    from: fromId
      ? {
          id: fromId,
          name: others.find((o) => o.id === fromId)?.name ?? null,
          problem,
          live: journey.continuesFrom === fromId && Boolean(journey.publishedVersion),
        }
      : null,
    next,
  };
}

// ---- Setting the link from the END of the earlier journey ------------------------------------

type LinkResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string; detail?: unknown };

export const LinkNextInput = z.object({ nextJourneyId: z.string().min(1).max(64) });

/**
 * "Then continue to…" on a journey's End: make `nextJourneyId` start after
 * `journeyId`. It changes ONLY the next journey's DRAFT trigger (in a
 * transaction on the fresh doc, so nothing else in that draft moves); the next
 * journey's published version keeps running as it is until a person publishes it.
 */
export async function linkNextJourney(
  ctx: TenantContext,
  journeyId: string,
  input: unknown,
  deps: { db?: FirestoreLike; nowMs?: number; authoredBy?: "human" | "agent" } = {},
): Promise<LinkResult<{ next: LifecycleJourney }>> {
  const parsed = LinkNextInput.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400, error: "invalid_input", detail: zodReason(parsed.error) };
  const repo = forTenant(ctx, deps.db);
  const [from, next] = await Promise.all([repo.lifecycleJourneys.getById(journeyId), repo.lifecycleJourneys.getById(parsed.data.nextJourneyId)]);
  if (!from || from.status === "archived" || isWaitlistJourney(from)) return { ok: false, status: 404, error: "not_found" };
  if (!next || next.status === "archived") return { ok: false, status: 404, error: "next_journey_not_found" };
  const trigger = { ...next.draft.settings.trigger, event: JOURNEY_COMPLETED_EVENT, afterJourneyId: from.id };
  const check = await resolveUpstream(ctx, next, { trigger }, deps.db);
  if (check?.problem) return { ok: false, status: 409, error: `continue_from_${check.problem}` };

  const updatedAt = new Date(deps.nowMs ?? Date.now()).toISOString();
  const saved = await repo.lifecycleJourneys.claim(next.id, (current) => {
    if (current.status === "archived") return null;
    const settings = current.draft.settings;
    return {
      draft: { ...current.draft, settings: { ...settings, trigger: { ...settings.trigger, event: JOURNEY_COMPLETED_EVENT, afterJourneyId: from.id } } },
      updatedAt,
      ...(deps.authoredBy === "agent" ? { authoredBy: "agent" as const } : {}),
    };
  });
  if (!saved) return { ok: false, status: 404, error: "next_journey_not_found" };
  return { ok: true, value: { next: saved } };
}
