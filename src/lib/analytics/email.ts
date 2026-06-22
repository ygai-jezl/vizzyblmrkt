import { forTenant } from "@/lib/tenant";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import type { EmailEvent } from "@/lib/types/emailEvent";
import type { Journey } from "@/lib/types/journey";
import { journeyIdFor } from "@/lib/journey/service";
import { CONTROL } from "@/lib/journey/allocation";
import { computeBqEmailBreakdown, type RawEngagement } from "./bigquery";

const RAW_ZERO: RawEngagement = { sent: 0, opened: 0, clicked: 0, failed: 0, unsubscribed: 0 };

/**
 * Email engagement analytics for a launch's Analytics tab. Two grains:
 *  - computeEmailAnalytics: launch-wide KPI cards + one table row per email
 *    SEQUENCE (journey) and one per sent BROADCAST.
 *  - computeSequenceEmailBreakdown: per-email (per-node) drill-in for a sequence,
 *    with per-A/B-arm sub-rows.
 *
 * Journey engagement comes from our `email_events` (Mandrill webhook); broadcast
 * engagement comes from MailChimp reports synced onto broadcast.stats (see
 * lib/mailchimp/reports.ts). Counts are unique-per-recipient — the event store
 * dedupes per (node, recipient, variant, type).
 */

// Events can outnumber signups (several per recipient); cap defensively.
const READ_CAP = 50000;

export interface EngagementCounts {
  sent: number;
  delivered: number;
  opened: number; // unique opens
  clicked: number; // unique clicks
  unsubscribed: number; // unique unsubscribes (count, not a rate)
  openRate: number; // opened / delivered (0..1)
  clickRate: number; // clicked / delivered (0..1)
}

export interface SequenceRow extends EngagementCounts {
  kind: "sequence";
  id: string; // journeyId
  name: string;
  enrolled: number; // distinct recipients reached in the sequence
}

export interface BroadcastRow {
  kind: "broadcast";
  id: string; // broadcastId
  name: string;
  enrolled: number; // recipients (emailsSent)
  delivered: number;
  openRate: number;
  clickRate: number;
  unsubscribed: number; // unique unsubscribes (count) from the MailChimp report
  /** Stats not yet synced from MailChimp (show "—" / pending in the UI). */
  pending: boolean;
}

export interface EmailAnalytics {
  cards: {
    sends: number;
    deliveryRate: number;
    openRate: number;
    clickRate: number;
  };
  sequences: SequenceRow[];
  broadcasts: BroadcastRow[];
  truncated: boolean;
}

/** Pure aggregation over a set of events. Exported for testing. */
export function aggregateEvents(events: EmailEvent[]): EngagementCounts {
  const raw: RawEngagement = { ...RAW_ZERO };
  for (const e of events) {
    switch (e.type) {
      case "send":
        raw.sent += 1;
        break;
      case "open":
        raw.opened += 1;
        break;
      case "click":
        raw.clicked += 1;
        break;
      case "bounce":
      case "reject":
        raw.failed += 1;
        break;
      case "unsub":
        raw.unsubscribed += 1; // post-delivery; does NOT reduce delivered
        break;
      default:
        break; // soft_bounce/spam don't reduce delivered
    }
  }
  return engagementFromRaw(raw);
}

/**
 * Shared delivered/open-rate/click-rate math from raw event-type tallies. The
 * single source of truth for both the Firestore path (aggregateEvents) and the
 * BigQuery path (computeBqEmailBreakdown returns the same RawEngagement shape).
 */
export function engagementFromRaw(raw: RawEngagement): EngagementCounts {
  const delivered = Math.max(0, raw.sent - raw.failed);
  return {
    sent: raw.sent,
    delivered,
    opened: raw.opened,
    clicked: raw.clicked,
    unsubscribed: raw.unsubscribed,
    openRate: delivered > 0 ? raw.opened / delivered : 0,
    clickRate: delivered > 0 ? raw.clicked / delivered : 0,
  };
}

function sequenceName(journey: Journey): string {
  const emails = journey.graph.nodes.filter((n) => n.type === "email").length;
  return emails === 1 ? "Email sequence (1 email)" : `Email sequence (${emails} emails)`;
}

export async function computeEmailAnalytics(
  ctx: TenantContext,
  campaignId: string,
  db?: FirestoreLike,
): Promise<EmailAnalytics> {
  const journeyId = journeyIdFor(campaignId);
  const journey = await forTenant(ctx, db).journeys.getById(journeyId);

  const sequences: SequenceRow[] = [];
  let truncated = false;
  if (journey) {
    // Equality-only (tenantId + journeyId) — no composite index required.
    const rows = await forTenant(ctx, db).emailEvents.find({
      where: [["journeyId", "==", journeyId]],
      limit: READ_CAP + 1,
    });
    truncated = rows.length > READ_CAP;
    const events = truncated ? rows.slice(0, READ_CAP) : rows;
    const counts = aggregateEvents(events);
    const enrolled = new Set(
      events.filter((e) => e.type === "send").map((e) => e.signupId),
    ).size;
    sequences.push({
      kind: "sequence",
      id: journeyId,
      name: sequenceName(journey),
      enrolled,
      ...counts,
    });
  }

  const broadcasts = await loadBroadcastRows(ctx, campaignId, db);

  return { cards: computeCards(sequences, broadcasts), sequences, broadcasts, truncated };
}

/**
 * Sent broadcasts for a launch as BroadcastRow[]. Broadcast engagement comes from
 * MailChimp reports synced onto broadcast.stats (small, bounded) — it is NOT in
 * email_events, so this stays a Firestore read in both the Firestore and BigQuery
 * paths. Shared by computeEmailAnalytics and computeHybridEmailAnalytics.
 */
async function loadBroadcastRows(
  ctx: TenantContext,
  campaignId: string,
  db?: FirestoreLike,
): Promise<BroadcastRow[]> {
  const broadcastsRaw = await forTenant(ctx, db).broadcasts.find({
    where: [["campaignId", "==", campaignId]],
    limit: 500,
  });
  return broadcastsRaw
    .filter((b) => b.status === "sent")
    .map((b) => {
      const stats = b.stats ?? null;
      const sent = stats?.emailsSent ?? 0;
      return {
        kind: "broadcast" as const,
        id: b.id,
        name: b.name,
        enrolled: sent,
        delivered: sent,
        openRate: stats?.openRate ?? 0,
        clickRate: stats?.clickRate ?? 0,
        unsubscribed: stats?.unsubscribed ?? 0,
        pending: !stats,
      };
    });
}

/** Launch-wide KPI roll-up across sequences (exact counts) + broadcasts (rates). */
export function computeCards(
  sequences: SequenceRow[],
  broadcasts: BroadcastRow[],
): EmailAnalytics["cards"] {
  let sends = 0;
  let delivered = 0;
  let opens = 0;
  let clicks = 0;
  for (const s of sequences) {
    sends += s.sent;
    delivered += s.delivered;
    opens += s.opened;
    clicks += s.clicked;
  }
  for (const b of broadcasts) {
    sends += b.enrolled;
    delivered += b.delivered;
    opens += Math.round(b.openRate * b.delivered);
    clicks += Math.round(b.clickRate * b.delivered);
  }
  return {
    sends,
    deliveryRate: sends > 0 ? delivered / sends : 0,
    openRate: delivered > 0 ? opens / delivered : 0,
    clickRate: delivered > 0 ? clicks / delivered : 0,
  };
}

export interface ArmBreakdown extends EngagementCounts {
  variantId: string; // "control" or a variant id
  label: string; // "Control", "Variant A", …
}

export interface NodeBreakdown extends EngagementCounts {
  nodeId: string;
  label: string;
  abTest: boolean;
  status?: "running" | "promoted";
  winnerVariantId?: string | null;
  /** Per-arm rows when an A/B test exists (control + each variant); else empty. */
  arms: ArmBreakdown[];
}

export async function computeSequenceEmailBreakdown(
  ctx: TenantContext,
  journeyId: string,
  db?: FirestoreLike,
): Promise<{ nodes: NodeBreakdown[]; truncated: boolean }> {
  const journey = await forTenant(ctx, db).journeys.getById(journeyId);
  if (!journey) return { nodes: [], truncated: false };

  const rows = await forTenant(ctx, db).emailEvents.find({
    where: [["journeyId", "==", journeyId]],
    limit: READ_CAP + 1,
  });
  const truncated = rows.length > READ_CAP;
  const events = truncated ? rows.slice(0, READ_CAP) : rows;

  const byNode = new Map<string, EmailEvent[]>();
  for (const e of events) {
    const arr = byNode.get(e.nodeId);
    if (arr) arr.push(e);
    else byNode.set(e.nodeId, [e]);
  }

  const nodes: NodeBreakdown[] = journey.graph.nodes
    .filter((n) => n.type === "email")
    .map((node) => {
      const nodeEvents = byNode.get(node.id) ?? [];
      const counts = aggregateEvents(nodeEvents);
      const ab = node.data.abTest;
      let arms: ArmBreakdown[] = [];
      if (ab) {
        const armIds = [CONTROL, ...ab.variants.map((v) => v.variantId)];
        arms = armIds.map((vid, i) => ({
          variantId: vid,
          label: vid === CONTROL ? "Control" : `Variant ${String.fromCharCode(64 + i)}`,
          ...aggregateEvents(nodeEvents.filter((e) => e.variantId === vid)),
        }));
      }
      return {
        nodeId: node.id,
        label: node.data.label || node.data.subject || "Untitled email",
        abTest: !!ab,
        status: ab?.status,
        winnerVariantId: ab?.winnerVariantId ?? null,
        arms,
        ...counts,
      };
    });

  return { nodes, truncated };
}

/**
 * Hybrid email analytics: full-population sequence engagement from BigQuery (no
 * 50k cap) + broadcasts from Firestore. Falls back to the Firestore-capped path
 * when BigQuery is off/unconfigured/errors. `computeEmailAnalytics` stays the
 * Firestore seam.
 */
export async function computeHybridEmailAnalytics(
  ctx: TenantContext,
  campaignId: string,
  db?: FirestoreLike,
): Promise<EmailAnalytics> {
  const journeyId = journeyIdFor(campaignId);
  const bq = await computeBqEmailBreakdown(ctx, journeyId).catch(() => null);
  if (!bq) return computeEmailAnalytics(ctx, campaignId, db);

  const journey = await forTenant(ctx, db).journeys.getById(journeyId);
  const sequences: SequenceRow[] = [];
  if (journey) {
    sequences.push({
      kind: "sequence",
      id: journeyId,
      name: sequenceName(journey),
      enrolled: bq.sequence.enrolled,
      ...engagementFromRaw(bq.sequence),
    });
  }
  const broadcasts = await loadBroadcastRows(ctx, campaignId, db);
  // BigQuery has no read cap → never truncated.
  return { cards: computeCards(sequences, broadcasts), sequences, broadcasts, truncated: false };
}

/**
 * Hybrid per-email (per-node) breakdown: full-population per-node / per-arm
 * counts from BigQuery (no 50k cap). Falls back to the Firestore path when
 * BigQuery is off/unconfigured/errors. Node STRUCTURE (which nodes exist, their
 * labels + A/B config) always comes from the journey doc, so every email node is
 * listed even when it has zero events.
 */
export async function computeHybridSequenceBreakdown(
  ctx: TenantContext,
  journeyId: string,
  db?: FirestoreLike,
): Promise<{ nodes: NodeBreakdown[]; truncated: boolean }> {
  const bq = await computeBqEmailBreakdown(ctx, journeyId).catch(() => null);
  if (!bq) return computeSequenceEmailBreakdown(ctx, journeyId, db);

  const journey = await forTenant(ctx, db).journeys.getById(journeyId);
  if (!journey) return { nodes: [], truncated: false };

  const byNode = new Map(bq.nodes.map((n) => [n.nodeId, n]));
  const nodes: NodeBreakdown[] = journey.graph.nodes
    .filter((n) => n.type === "email")
    .map((node) => {
      const bqNode = byNode.get(node.id);
      const counts = engagementFromRaw(bqNode?.counts ?? RAW_ZERO);
      const ab = node.data.abTest;
      let arms: ArmBreakdown[] = [];
      if (ab) {
        const armCounts = new Map(
          (bqNode?.arms ?? []).map((a) => [a.variantId, a.counts]),
        );
        const armIds = [CONTROL, ...ab.variants.map((v) => v.variantId)];
        arms = armIds.map((vid, i) => ({
          variantId: vid,
          label: vid === CONTROL ? "Control" : `Variant ${String.fromCharCode(64 + i)}`,
          ...engagementFromRaw(armCounts.get(vid) ?? RAW_ZERO),
        }));
      }
      return {
        nodeId: node.id,
        label: node.data.label || node.data.subject || "Untitled email",
        abTest: !!ab,
        status: ab?.status,
        winnerVariantId: ab?.winnerVariantId ?? null,
        arms,
        ...counts,
      };
    });

  return { nodes, truncated: false };
}
