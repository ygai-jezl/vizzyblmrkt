import type { EmailEvent } from "@/lib/types/emailEvent";
import type { DeliveryMode, LifecycleEnrolment, LifecycleJourney, LifecycleVersion, SentItem } from "@/lib/types/lifecycle";
import { sendNote } from "./personJourneys";

/**
 * Every email one person was sent, across their journeys, with what they did with
 * it. The sends come from each enrolment's own record (so one that was skipped or
 * never confirmed shows too); opens, clicks, bounces and complaints are folded in
 * from the provider's `email_events`. Pure.
 */

export interface PersonEmail {
  enrolmentId: string;
  journeyId: string;
  journeyName: string;
  nodeId: string;
  itemId: string;
  /** The email's name in the journey, e.g. "R1 · First reminder". */
  label: string;
  /** The subject as the person read it; for a send from before subjects were kept, the template's with what we can fill. */
  subject: string | null;
  at: string;
  status: SentItem["status"];
  mode: DeliveryMode;
  /** Why it was skipped or is unknown, in plain words. */
  note: string | null;
  /** `ai`: the reviewed AI line went out; `fallback`: the standard wording did instead. Null for an email with no AI line. */
  version: "ai" | "fallback" | null;
  /** The AI line that went out, when we kept it. */
  line: string | null;
  /** Whether this email could tell us about opens and clicks at all. */
  tracked: { opens: boolean; clicks: boolean };
  /** First open, and first click with its link (the provider's rows keep the first of each). */
  openedAt: string | null;
  clickedAt: string | null;
  clickUrl: string | null;
  bounced: boolean;
  complained: boolean;
  unsubscribed: boolean;
}

export interface PersonEmailCounts {
  sent: number;
  /** Opened, as far as we can tell: an open seen, or a click (which is an open too). */
  opened: number;
  clicked: number;
  /** How many of the sent emails could have told us about an open: only these can be said to be unopened. */
  tracked: number;
  /** How many could have told us about a click. */
  trackedClicks: number;
}

interface Entry {
  enrolment: Pick<LifecycleEnrolment, "id" | "journeyId" | "sentItems">;
  journey: Pick<LifecycleJourney, "id" | "name" | "tracking">;
  version: Pick<LifecycleVersion, "pools" | "settings"> | null;
}

const TOKEN_RE = /\{\{\s*([A-Za-z_][\w.]*)\s*(?:\|([^}]*))?\}\}/g;

/** A template subject with the tokens we can fill; any other token falls back to its default (or nothing). */
export function subjectPreview(template: string, values: { firstName?: string | null; productName?: string | null }): string {
  const known: Record<string, string | null | undefined> = { "user.first_name": values.firstName, "product.name": values.productName };
  return template
    .replace(TOKEN_RE, (_m, key: string, fallback?: string) => known[key]?.trim() || (fallback ?? "").trim())
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function personEmails(
  entries: Entry[],
  events: ReadonlyArray<Pick<EmailEvent, "journeyId" | "nodeId" | "variantId" | "type" | "ts" | "url" | "enrolmentId">>,
  values: { firstName?: string | null; productName?: string | null } = {},
): PersonEmail[] {
  type Row = (typeof events)[number];
  // Rows that name their enrolment belong to that entry. Older rows only name the journey's step.
  const byEntry = new Map<string, Row[]>();
  const byStep = new Map<string, Row[]>();
  for (const ev of events) {
    const map = ev.enrolmentId ? byEntry : byStep;
    const key = ev.enrolmentId ? `${ev.enrolmentId}|${ev.nodeId}|${ev.variantId}` : `${ev.journeyId}|${ev.nodeId}|${ev.variantId}`;
    const list = map.get(key);
    if (list) list.push(ev);
    else map.set(key, [ev]);
  }

  const sends = entries
    .flatMap((entry) => entry.enrolment.sentItems.map((sent) => ({ entry, sent })))
    .sort((a, b) => a.sent.at.localeCompare(b.sent.at));
  // An older row goes to the send it followed: the last send of that step made before it, among
  // the sends from before rows named their enrolment (those kept no `tracked`). The same step sent
  // again on a later entry would otherwise hand its open to the first.
  const older = new Map<(typeof sends)[number], Row[]>();
  for (const [key, rows] of byStep) {
    const could = sends.filter((x) => x.sent.status !== "skipped" && !x.sent.tracked && `${x.entry.journey.id}|${x.sent.nodeId}|${x.sent.itemId}` === key);
    for (const row of rows) {
      const owner = could.findLast((x) => x.sent.at <= row.ts) ?? could[0];
      if (owner) older.set(owner, [...(older.get(owner) ?? []), row]);
    }
  }
  const out: PersonEmail[] = [];
  for (const send of sends) {
    const { entry, sent } = send;
    const { enrolment, journey, version } = entry;
    const item = version?.pools.find((p) => p.id === sent.poolId)?.items.find((i) => i.id === sent.itemId);
    const rows = sent.status === "skipped" ? [] : (byEntry.get(`${enrolment.id}|${sent.nodeId}|${sent.itemId}`) ?? older.get(send) ?? []);
    const first = (type: EmailEvent["type"]) => rows.filter((r) => r.type === type).sort((a, b) => a.ts.localeCompare(b.ts))[0];
    const open = first("open");
    const click = first("click");
    // A send from before `tracked` was kept: what its version asked for (shadow mail is never attributed).
    const tracked = sent.tracked ?? (sent.mode === "shadow" ? { opens: false, clicks: false } : (version?.settings.tracking ?? { opens: false, clicks: false }));
    out.push({
      enrolmentId: enrolment.id,
      journeyId: journey.id,
      journeyName: journey.name,
      nodeId: sent.nodeId,
      itemId: sent.itemId,
      label: item?.label ?? sent.itemId,
      subject: sent.subject ?? (item?.subject ? subjectPreview(item.subject, values) : null),
      at: sent.at,
      status: sent.status,
      mode: sent.mode,
      note: sendNote(sent),
      version: sent.version === "ai" || sent.version === "fallback" ? sent.version : null,
      line: sent.line ?? null,
      // A row that arrived shows it was tracked, whatever the setting says now.
      tracked: { opens: tracked.opens || Boolean(open), clicks: tracked.clicks || Boolean(click) },
      openedAt: open?.ts ?? null,
      clickedAt: click?.ts ?? null,
      clickUrl: click?.url ?? null,
      bounced: rows.some((r) => r.type === "bounce" || r.type === "soft_bounce" || r.type === "reject"),
      complained: rows.some((r) => r.type === "spam"),
      unsubscribed: rows.some((r) => r.type === "unsub"),
    });
  }
  return out.reverse();
}

/** Sent, opened and clicked, counting an email once (a click counts as an open too), and how many could have told us. */
export function emailCounts(emails: readonly PersonEmail[]): PersonEmailCounts {
  const delivered = emails.filter((e) => e.status !== "skipped");
  return {
    sent: delivered.length,
    opened: delivered.filter((e) => e.openedAt || e.clickedAt).length,
    clicked: delivered.filter((e) => e.clickedAt).length,
    tracked: delivered.filter((e) => e.tracked.opens).length,
    trackedClicks: delivered.filter((e) => e.tracked.clicks).length,
  };
}
