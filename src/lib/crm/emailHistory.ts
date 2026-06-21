import { forTenant } from "@/lib/tenant";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import type { Contact } from "@/lib/types/contact";
import type { EmailEvent } from "@/lib/types/emailEvent";

/**
 * One email a contact was sent, with engagement folded in. Built from the
 * Mandrill-webhook `email_events` stream (one row per journey-step/recipient/arm/
 * event-type, deduped) — so opens/clicks are boolean per email, not counts.
 */
export interface ContactEmailHistoryEntry {
  journeyId: string;
  nodeId: string;
  signupId: string;
  variantId: string;
  campaignId: string;
  subject: string | null;
  sentAt: string | null;
  opened: boolean;
  openedAt: string | null;
  clicked: boolean;
  clickedAt: string | null;
  clickUrl: string | null;
  bounced: boolean;
  status: "sent" | "opened" | "clicked" | "bounced";
}

/**
 * Resolve a contact's email history. Maps the contact to its per-campaign
 * signupIds, reads that person's `email_events`, groups them into one entry per
 * (journey step, recipient, A/B arm), and resolves each email's subject from the
 * journey graph. Read-only; no external API calls (engagement already arrived via
 * the webhook). Journey emails only — broadcasts aren't in email_events yet.
 */
export async function getContactEmailHistory(
  ctx: TenantContext,
  contact: Contact,
  db?: FirestoreLike,
): Promise<ContactEmailHistoryEntry[]> {
  const repo = forTenant(ctx, db);
  const signupIds = Array.from(
    new Set(contact.campaigns.map((c) => c.signupId).filter(Boolean)),
  );
  if (signupIds.length === 0) return [];

  const events: EmailEvent[] = [];
  for (const sid of signupIds) {
    const rows = await repo.emailEvents.find({ where: [["signupId", "==", sid]] });
    events.push(...rows);
  }
  if (events.length === 0) return [];

  // Resolve email-node subjects from each referenced journey graph.
  const subjectByNode = new Map<string, string>();
  for (const jid of new Set(events.map((e) => e.journeyId))) {
    const journey = await repo.journeys.getById(jid).catch(() => null);
    if (!journey) continue;
    for (const node of journey.graph.nodes) {
      if (node.type === "email") {
        subjectByNode.set(`${jid}:${node.id}`, node.data?.subject ?? "");
      }
    }
  }

  // Group into one entry per (journey step, recipient, arm).
  const groups = new Map<string, EmailEvent[]>();
  for (const e of events) {
    const key = `${e.journeyId}:${e.nodeId}:${e.signupId}:${e.variantId}`;
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }

  const entries: ContactEmailHistoryEntry[] = [];
  for (const evs of groups.values()) {
    const byType = new Map(evs.map((e) => [e.type, e]));
    const send = byType.get("send");
    const open = byType.get("open");
    const click = byType.get("click");
    const bounce = byType.get("bounce") ?? byType.get("soft_bounce");
    const first = evs[0]!;
    entries.push({
      journeyId: first.journeyId,
      nodeId: first.nodeId,
      signupId: first.signupId,
      variantId: first.variantId,
      campaignId: first.campaignId,
      subject: subjectByNode.get(`${first.journeyId}:${first.nodeId}`) ?? null,
      sentAt: send?.ts ?? null,
      opened: !!open,
      openedAt: open?.ts ?? null,
      clicked: !!click,
      clickedAt: click?.ts ?? null,
      clickUrl: click?.url ?? null,
      bounced: !!bounce,
      status: click ? "clicked" : open ? "opened" : bounce ? "bounced" : "sent",
    });
  }

  // Newest first; fall back to any available timestamp when send wasn't recorded.
  const tsOf = (e: ContactEmailHistoryEntry) =>
    e.sentAt ?? e.openedAt ?? e.clickedAt ?? "";
  entries.sort((a, b) => tsOf(b).localeCompare(tsOf(a)));
  return entries;
}
