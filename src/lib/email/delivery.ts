import { forTenant, getTenantById, listAllTenants } from "@/lib/tenant";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import type { Region, Tenant } from "@/lib/types/tenant";
import type { EmailJob } from "@/lib/types/emailJob";
import type { Journey, JourneyGraph, JourneyNode } from "@/lib/types/journey";
import { sendEmail } from "@/lib/email";
import { resolveSender } from "@/lib/email/sender";
import { compileBroadcast, compileJourneyEmail } from "@/lib/agents";
import {
  resolveMailchimpConfig,
  createCampaign,
  setCampaignContent,
  sendCampaign,
  getCampaignStatus,
  findTagSegmentId,
  campaignTag,
} from "@/lib/mailchimp";
import { computeRanks } from "@/lib/waitlist/rank";
import { selectBranch } from "@/lib/journey/conditions";
import { enqueueEmailJob } from "./jobs";

const MAX_ATTEMPTS = 3;
/** Visibility timeout: a "processing" claim older than this is reclaimable. */
const LEASE_MS = 5 * 60_000;

/**
 * Drain due jobs from the queue. Idempotent + best-effort: a failed job retries
 * up to MAX_ATTEMPTS, then parks as "failed". Designed to be kicked inline after
 * enqueue (immediate sends) AND on a schedule (Cloud Scheduler) for future
 * journey steps. Single-worker semantics for MVP — claims aren't transactional.
 */
export async function processEmailJobs(
  ctx: TenantContext,
  limit = 25,
): Promise<{ processed: number; done: number; failed: number }> {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const staleBefore = new Date(nowMs - LEASE_MS).toISOString();

  // Due pending jobs, PLUS jobs whose "processing" claim has expired (a prior
  // worker crashed mid-run) so they can be reclaimed rather than stuck forever.
  const [due, stale] = await Promise.all([
    forTenant(ctx).emailJobs.find({
      where: [
        ["status", "==", "pending"],
        ["scheduledAt", "<=", now],
      ],
      orderBy: [["scheduledAt", "asc"]],
      limit,
    }),
    forTenant(ctx).emailJobs.find({
      where: [
        ["status", "==", "processing"],
        ["claimedAt", "<=", staleBefore],
      ],
      orderBy: [["claimedAt", "asc"]],
      limit,
    }),
  ]);
  const seen = new Set<string>();
  const jobs = [...due, ...stale].filter((j) => {
    if (seen.has(j.id)) return false;
    seen.add(j.id);
    return true;
  });

  // Rank is expensive (one ordered scan); compute once per campaign per run.
  const rankCache = new Map<string, Map<string, number>>();
  let done = 0;
  let failed = 0;

  for (const job of jobs) {
    const attempts = job.attempts + 1;
    await forTenant(ctx).emailJobs.update(job.id, {
      status: "processing",
      attempts,
      claimedAt: new Date().toISOString(),
    });
    try {
      if (job.type === "broadcast") await processBroadcastJob(ctx, job);
      else await processJourneyStepJob(ctx, job, rankCache);
      await forTenant(ctx).emailJobs.update(job.id, {
        status: "done",
        processedAt: new Date().toISOString(),
        lastError: null,
      });
      done += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const exhausted = attempts >= MAX_ATTEMPTS;
      await forTenant(ctx).emailJobs.update(job.id, {
        status: exhausted ? "failed" : "pending",
        lastError: msg,
        processedAt: exhausted ? new Date().toISOString() : null,
      });
      if (exhausted && job.type === "broadcast") {
        const bid = String(job.payload.broadcastId ?? "");
        if (bid) {
          await forTenant(ctx)
            .broadcasts.update(bid, { status: "failed", lastError: msg })
            .catch(() => {});
        }
      }
      failed += 1;
    }
  }
  return { processed: jobs.length, done, failed };
}

export interface TenantDrainResult {
  tenants: number;
  processed: number;
  done: number;
  failed: number;
  perTenant: Array<
    | { tenantId: string; region: Region; processed: number; done: number; failed: number }
    | { tenantId: string; region: Region; error: string }
  >;
}

/**
 * Fan the delivery worker out over EVERY tenant, across all regional databases
 * (US/EU/Asia). The scheduled (Cloud Scheduler) worker calls this: a single cron
 * has no one tenant context, so it must drain each tenant's queue in turn. One
 * tenant's failure (e.g. an unprovisioned region, or a transient read error) is
 * logged and skipped so it can never stall the others.
 */
export async function processEmailJobsForAllTenants(
  limitPerTenant = 100,
  deps: {
    listTenants?: () => Promise<Tenant[]>;
    drain?: (
      ctx: TenantContext,
      limit: number,
    ) => Promise<{ processed: number; done: number; failed: number }>;
  } = {},
): Promise<TenantDrainResult> {
  const listTenants = deps.listTenants ?? listAllTenants;
  const drain = deps.drain ?? processEmailJobs;
  const tenants = await listTenants();
  let processed = 0;
  let done = 0;
  let failed = 0;
  const perTenant: TenantDrainResult["perTenant"] = [];
  for (const t of tenants) {
    const ctx: TenantContext = {
      tenantId: t.id,
      region: t.region,
      source: "system",
    };
    try {
      const r = await drain(ctx, limitPerTenant);
      processed += r.processed;
      done += r.done;
      failed += r.failed;
      perTenant.push({ tenantId: t.id, region: t.region, ...r });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      console.warn(`[delivery] tenant ${t.id} (${t.region}) drain failed: ${msg}`);
      perTenant.push({ tenantId: t.id, region: t.region, error: msg });
    }
  }
  return { tenants: tenants.length, processed, done, failed, perTenant };
}

// ---- Broadcast (MailChimp Marketing campaign) -----------------------------

async function processBroadcastJob(ctx: TenantContext, job: EmailJob): Promise<void> {
  const broadcastId = String(job.payload.broadcastId ?? "");
  const repo = forTenant(ctx).broadcasts;
  const b = await repo.getById(broadcastId);
  if (!b) throw new Error("broadcast_not_found");
  if (b.status === "sent") return; // idempotent re-run
  const campaign = await forTenant(ctx).campaigns.getById(b.campaignId);
  if (!campaign) throw new Error("campaign_not_found");
  // Archived (closed) launch: don't dispatch queued broadcasts. Skip WITHOUT
  // throwing — a throw would burn retries and eventually park the job as
  // "failed"; instead the job is simply left unsent while the launch is closed
  // (pausing the journey doesn't cover broadcasts, so this is the guard for them).
  if (campaign.archivedAt) return;

  const tenant = await getTenantById(ctx.tenantId).catch(() => null);
  const cfg = resolveMailchimpConfig(tenant);
  if (!cfg.ok) throw new Error(`mailchimp_config:${cfg.reason}`);

  // Reuse a campaign from a prior (interrupted) attempt instead of creating a
  // second one — a fresh createCampaign on each retry is what would double-send.
  // The id is persisted BEFORE dispatch, so any retry lands here with it set.
  let mcId = b.mailchimpCampaignId ?? null;
  if (!mcId) {
    // Scope recipients to THIS launch's subscribers (its audience tag). Fail
    // safe: if the tag-segment doesn't exist yet (no one synced), refuse rather
    // than fall back to the whole shared audience and over-send.
    const segmentId = await findTagSegmentId(cfg.config, campaignTag(campaign.id));
    if (segmentId == null) throw new Error("no_audience_segment_for_launch");
    const compiled = compileBroadcast(
      { subject: b.subject, body: b.body, heroImageUrl: b.heroImageUrl ?? null },
      campaign,
    );
    // Tenant/campaign sender identity overrides the env defaults. NOTE: a
    // MailChimp Marketing campaign can only override the display name + reply-to;
    // the From *address/domain* is governed by the MailChimp account's own domain
    // authentication, so `sender.fromEmail` does not apply to broadcasts.
    const sender = resolveSender(tenant, campaign);
    const created = await createCampaign(cfg.config, {
      subject: compiled.subject,
      title: `${campaign.waitlistName} — ${b.name}`,
      fromName: sender.fromName ?? campaign.waitlistName,
      replyTo: sender.replyTo ?? replyToAddress(),
      segmentId,
    });
    if (!created.ok || !created.data?.id) {
      throw new Error(`create_campaign:${created.reason ?? "no_id"}`);
    }
    mcId = created.data.id;
    await repo.update(broadcastId, { status: "sending", mailchimpCampaignId: mcId });
    const content = await setCampaignContent(cfg.config, mcId, compiled.html);
    if (!content.ok) throw new Error(`set_content:${content.reason}`);
  }

  // Don't re-dispatch a campaign MailChimp already sent (interrupted retry).
  const mcStatus = await getCampaignStatus(cfg.config, mcId);
  if (mcStatus && ["sent", "sending", "schedule"].includes(mcStatus)) {
    await repo.update(broadcastId, {
      status: "sent",
      sentAt: new Date().toISOString(),
      lastError: null,
    });
    return;
  }

  const sent = await sendCampaign(cfg.config, mcId);
  if (!sent.ok) throw new Error(`send:${sent.reason}`);

  await repo.update(broadcastId, {
    status: "sent",
    sentAt: new Date().toISOString(),
    lastError: null,
  });
}

// ---- Journey step (per-recipient, Mandrill) -------------------------------

async function processJourneyStepJob(
  ctx: TenantContext,
  job: EmailJob,
  rankCache: Map<string, Map<string, number>>,
): Promise<void> {
  const journeyId = String(job.payload.journeyId ?? "");
  const nodeId = String(job.payload.nodeId ?? "");
  const signupId = String(job.payload.signupId ?? "");

  const journey = await forTenant(ctx).journeys.getById(journeyId);
  if (!journey) throw new Error("journey_not_found");
  if (journey.status !== "active") return; // paused/draft → stop the chain

  const node = journey.graph.nodes.find((n) => n.id === nodeId);
  if (!node || (node.type !== "email" && node.type !== "condition")) {
    throw new Error("journey_node_not_found");
  }

  const signup = await forTenant(ctx).signups.getById(signupId);
  // Recipient gone/unverified → silently drop (don't fail, don't continue).
  if (!signup || signup.status !== "verified_active" || !signup.email) return;

  const campaign = await forTenant(ctx).campaigns.getById(journey.campaignId);
  if (!campaign) throw new Error("campaign_not_found");
  // Belt-and-braces: archiving a launch pauses its journey (which already stops
  // the chain above via the status guard), but if a journey is somehow active on
  // an archived launch, halt the step here too.
  if (campaign.archivedAt) return;

  // Rank is needed by email merge-vars AND rank-based conditions; cache per run.
  let ranks = rankCache.get(journey.campaignId);
  if (!ranks) {
    ranks = await computeRanks(ctx, journey.campaignId);
    rankCache.set(journey.campaignId, ranks);
  }
  const rank = ranks.get(signup.id);

  // Condition node: evaluate live data, route down the matching branch. Nothing
  // is sent — the condition's job already absorbed any preceding wait, so it
  // fires (and reads fresh data) at exactly the right time.
  if (node.type === "condition") {
    const handle = selectBranch(node.data.branches, { signup, campaign, rank });
    const next = resolveNextStep(journey.graph, nodeId, handle);
    if (next) await enqueueNext(ctx, journey, next, signupId);
    return;
  }

  const tenant = await getTenantById(ctx.tenantId).catch(() => null);
  const sender = resolveSender(tenant, campaign);

  const compiled = compileJourneyEmail(
    {
      subject: node.data.subject ?? "",
      body: node.data.body ?? "",
      heroImageUrl: node.data.heroImageUrl ?? null,
    },
    { signup, campaign, rank },
  );

  // Send once per job: if a prior attempt already dispatched (then failed during
  // the next-step enqueue), don't re-send — just continue to scheduling.
  if (!job.emailSentAt) {
    const res = await sendEmail({
      to: signup.email,
      subject: compiled.subject,
      html: compiled.html,
      text: compiled.text,
      fromEmail: sender.fromEmail,
      fromName: sender.fromName,
      replyTo: sender.replyTo,
    });
    // "log" provider (dev, no key) counts as success so the chain still advances.
    if (!res.sent && res.provider !== "log") {
      throw new Error(`send:${res.reason ?? "failed"}`);
    }
    await forTenant(ctx).emailJobs.update(job.id, {
      emailSentAt: new Date().toISOString(),
    });
  }

  // Schedule the next step (walking through any wait nodes).
  const next = resolveNextStep(journey.graph, nodeId);
  if (next) await enqueueNext(ctx, journey, next, signupId);
}

/** Enqueue the next journey step for a recipient. Idempotent per (node, recipient). */
async function enqueueNext(
  ctx: TenantContext,
  journey: Journey,
  next: { nodeId: string; delayHours: number },
  signupId: string,
): Promise<void> {
  const when = new Date(Date.now() + next.delayHours * 3600_000).toISOString();
  await enqueueEmailJob(ctx, {
    type: "journey_step",
    campaignId: journey.campaignId,
    dedupeKey: `journey:${journey.id}:${next.nodeId}:${signupId}`,
    payload: { journeyId: journey.id, nodeId: next.nodeId, signupId },
    scheduledAt: when,
  });
}

// ---- Orchestration helpers ------------------------------------------------

/** Enqueue (and let the worker send) a broadcast. Idempotent per broadcast id. */
export async function enqueueBroadcast(
  ctx: TenantContext,
  broadcastId: string,
  campaignId: string,
): Promise<"enqueued" | "duplicate"> {
  const dedupeKey = `broadcast:${broadcastId}`;
  const r = await enqueueEmailJob(ctx, {
    type: "broadcast",
    campaignId,
    dedupeKey,
    payload: { broadcastId },
  });
  if (r === "duplicate") {
    // A prior send parked the job as "failed" — resurrect it so the operator's
    // retry actually re-runs (the atomic create alone would silently no-op).
    const existing = await forTenant(ctx).emailJobs.getById(dedupeKey);
    if (existing && existing.status === "failed") {
      await forTenant(ctx).emailJobs.update(dedupeKey, {
        status: "pending",
        attempts: 0,
        scheduledAt: new Date().toISOString(),
        claimedAt: null,
        lastError: null,
      });
      return "enqueued";
    }
  }
  return r;
}

/**
 * Activate a journey: enqueue the first email step for every current verified
 * subscriber. Idempotent per (journey, node, recipient) via the dedupe key.
 */
export async function activateJourney(
  ctx: TenantContext,
  journey: Journey,
): Promise<{ enqueued: number }> {
  const first = firstStep(journey);
  if (!first) return { enqueued: 0 };

  const subs = await forTenant(ctx).signups.find({
    where: [
      ["campaignId", "==", journey.campaignId],
      ["status", "==", "verified_active"],
    ],
  });

  let enqueued = 0;
  for (const s of subs) {
    if (!s.email) continue;
    const when = new Date(Date.now() + first.delayHours * 3600_000).toISOString();
    const r = await enqueueEmailJob(ctx, {
      type: "journey_step",
      campaignId: journey.campaignId,
      dedupeKey: `journey:${journey.id}:${first.nodeId}:${s.id}`,
      payload: { journeyId: journey.id, nodeId: first.nodeId, signupId: s.id },
      scheduledAt: when,
    });
    if (r === "enqueued") enqueued += 1;
  }
  return { enqueued };
}

/**
 * The journey's first reachable step (an email or a condition), plus the delay
 * summed from any wait nodes between the entry and it. Shared by activation
 * (enrol the existing audience) and per-signup enrolment (enrol a late joiner),
 * so both compute the entry identically. Null when the graph has no entry or the
 * entry leads nowhere.
 */
function firstStep(
  journey: Journey,
): { nodeId: string; delayHours: number } | null {
  const entry = findEntryNode(journey.graph);
  if (!entry) return null;
  // Entry may BE (or lead to) an email or a condition node.
  return entry.type === "email" || entry.type === "condition"
    ? { nodeId: entry.id, delayHours: 0 }
    : resolveNextStep(journey.graph, entry.id);
}

/**
 * Enrol a single (newly verified) signup into the campaign's journey when one is
 * active — enqueue its first step. Idempotent per (journey, node, recipient) via
 * the same dedupe key activation uses, so it's safe even if activation already
 * enrolled them. Called best-effort from the signup/verify paths so late joiners
 * (anyone who verifies AFTER activation) still enter the sequence; the scheduled
 * worker then drains the step. A missing/inactive/empty journey just "skips".
 */
export async function enrollSignupInActiveJourney(
  ctx: TenantContext,
  campaignId: string,
  signup: { id: string; email?: string | null },
  db?: FirestoreLike,
): Promise<"enqueued" | "skipped"> {
  if (!signup.email) return "skipped";
  const journey = await forTenant(ctx, db).journeys.getById(
    `journey_${campaignId}`,
  );
  if (!journey || journey.status !== "active") return "skipped";
  const first = firstStep(journey);
  if (!first) return "skipped";
  const when = new Date(Date.now() + first.delayHours * 3600_000).toISOString();
  const r = await enqueueEmailJob(
    ctx,
    {
      type: "journey_step",
      campaignId,
      dedupeKey: `journey:${journey.id}:${first.nodeId}:${signup.id}`,
      payload: { journeyId: journey.id, nodeId: first.nodeId, signupId: signup.id },
      scheduledAt: when,
    },
    db,
  );
  return r === "enqueued" ? "enqueued" : "skipped";
}

export type JourneyValidation = { ok: true } | { ok: false; reason: string };

/**
 * Structural pre-flight for activation. Without it, activating an empty or
 * half-wired graph returns HTTP 200 yet enqueues nobody and silently sends
 * nothing. Requires: an entry node, that leads to a sendable step, with at least
 * one email node carrying real subject + body content.
 */
export function validateJourneyGraph(graph: JourneyGraph): JourneyValidation {
  const entry = findEntryNode(graph);
  if (!entry) return { ok: false, reason: "no_entry_node" };
  const first =
    entry.type === "email" || entry.type === "condition"
      ? entry.id
      : resolveNextStep(graph, entry.id)?.nodeId;
  if (!first) return { ok: false, reason: "entry_leads_nowhere" };
  const emails = graph.nodes.filter((n) => n.type === "email");
  if (emails.length === 0) return { ok: false, reason: "no_email_node" };
  const hasContent = emails.some(
    (n) => (n.data.subject ?? "").trim() && (n.data.body ?? "").trim(),
  );
  if (!hasContent) return { ok: false, reason: "email_missing_content" };
  return { ok: true };
}

/** Entry = the trigger node, else the first node with no incoming edge. */
function findEntryNode(graph: JourneyGraph): JourneyNode | null {
  const trigger = graph.nodes.find((n) => n.type === "trigger");
  if (trigger) return trigger;
  const hasIncoming = new Set(graph.edges.map((e) => e.target));
  return graph.nodes.find((n) => !hasIncoming.has(n.id)) ?? null;
}

export type NextStepType = "email" | "condition";

/**
 * From a node, follow outgoing edges through any wait nodes (summing their
 * hours) until the next email OR condition node. When leaving a condition node,
 * pass its chosen `branchHandle` to take the matching branch edge; otherwise the
 * single outgoing edge is followed. Returns null at a dead end (incl. an
 * unconnected branch). Guards against cycles.
 */
export function resolveNextStep(
  graph: JourneyGraph,
  fromNodeId: string,
  branchHandle?: string,
): { nodeId: string; delayHours: number; type: NextStepType } | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const pick = (id: string, handle?: string) => {
    const outs = graph.edges.filter((e) => e.source === id);
    return handle
      ? outs.find((e) => (e.sourceHandle ?? null) === handle)
      : outs[0];
  };

  let current = fromNodeId;
  let delayHours = 0;
  let handle = branchHandle; // branch-directed only on the first hop
  const seen = new Set<string>([fromNodeId]);

  for (let i = 0; i <= graph.nodes.length; i += 1) {
    const nextId = pick(current, handle)?.target;
    handle = undefined;
    if (!nextId || seen.has(nextId)) return null;
    seen.add(nextId);
    const node = byId.get(nextId);
    if (!node) return null;
    if (node.type === "email") return { nodeId: nextId, delayHours, type: "email" };
    if (node.type === "condition")
      return { nodeId: nextId, delayHours, type: "condition" };
    if (node.type === "wait") delayHours += node.data.waitHours ?? 0;
    current = nextId;
  }
  return null;
}

function replyToAddress(): string {
  const raw =
    process.env.EMAIL_REPLY_TO ||
    process.env.EMAIL_FROM ||
    "noreply@vizzybl.ai";
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1]! : raw).trim();
}
