import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { Contact } from "@/lib/types/contact";
import type { StoredEvent } from "@/lib/types/ontologyEvent";
import type { FieldValue, RecordField } from "@/lib/types/recordField";
import { getContactEmailHistory, type ContactEmailHistoryEntry } from "@/lib/crm/emailHistory";
import { ENVIRONMENT_LABEL, environmentOf, productNameOf } from "@/lib/connect/environments";
import { InvalidCursorError, listPersonEvents, TIMELINE_PAGE } from "@/lib/ontology/timeline";
import { isContactPersonId } from "@/lib/ontology/person";
import { memberLabel, teamMemberNames, type UserLookup } from "@/lib/team/names";
import { readFieldList } from "./fieldList";
import { valueText } from "./fields";
import { consentWayLabel } from "./newPerson";
import { parseMoveFieldId } from "./personMoves";

/**
 * One person's timeline (AUDIENCE_TIMELINE_ENABLED), newest first, a page at a time: what their
 * event history holds (being added, consent, field changes, their stage, product, launch and
 * quiet moves, Vizzy's suggestions) beside their sign-ups, the emails their launches sent and
 * their voice chats, which stay in their own stores. Each product's own story (what they did in
 * it, its journeys and emails) stays on that product's part of the page, so it isn't repeated.
 *
 * Paging follows the event history: a page is its next events, plus whatever else falls between
 * this page's oldest event and the last page's. The cursor is opaque: base64url of the event
 * history's cursor and that time. Only this person's rows are read: the events by their personId,
 * the rest from their own record.
 */

export interface TimelineEntry {
  /** Unique within the timeline. */
  id: string;
  at: string;
  kind: "created" | "consent" | "field" | "stage" | "product" | "launch" | "quiet" | "agent" | "signup" | "email" | "voice_chat";
  text: string;
  detail: string | null;
  /** A voice chat's sign-up, for Read the conversation (admins only). */
  signupId?: string;
}

export interface TimelineViewPage {
  entries: TimelineEntry[];
  /** Pass back for older entries; null when there are none. */
  next: string | null;
}

/** The most of each other source one timeline reads. */
const BESIDE_MAX = 200;

const STAGE: Record<string, string> = { new: "New", onboarding: "Onboarding", stuck: "Stuck", activated: "Activated", member: "Using the product" };
const LAUNCH_STATUS: Record<string, string> = { verified_active: "Confirmed their email", unverified: "Not confirmed yet", offboarded: "Offboarded" };

function encode(c: { e: string; b: string | null }): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decode(s: string): { e: string; b: string | null } {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]{1,800}$/.test(s)) throw new InvalidCursorError();
  try {
    const v = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as { e?: unknown; b?: unknown };
    if (typeof v.e !== "string" || (v.b !== null && (typeof v.b !== "string" || !Number.isFinite(Date.parse(v.b))))) throw new Error();
    return { e: v.e, b: v.b };
  } catch {
    throw new InvalidCursorError();
  }
}

/** A calendar day (a date field) in words, whatever the server's time zone. */
function calendarDay(v: string): string {
  const ms = Date.parse(`${v}T12:00:00.000Z`);
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : v;
}

interface Names {
  launches: Map<string, string>;
  products: Map<string, string>;
  fields: Map<string, RecordField>;
  people: Record<string, string>;
}

function fieldValueText(field: RecordField | undefined, v: unknown, people: Record<string, string>): string {
  if (!field) return Array.isArray(v) ? v.join(", ") : String(v);
  if (field.type === "team_member") return memberLabel(String(v), people);
  if (field.type === "date") return calendarDay(String(v));
  return valueText(field, v as FieldValue);
}

/** Who did it, in words. */
function byWhom(e: StoredEvent, people: Record<string, string>): string | null {
  if (e.actor.type === "member") return memberLabel(e.actor.id, people);
  if (e.actor.type === "agent") return "Vizzy";
  return null;
}

/** One stored event as an entry, or null for one the timeline leaves out. */
function fromEvent(e: StoredEvent, names: Names, launchesJoined: ReadonlySet<string>): TimelineEntry | null {
  const base = { id: e.id, at: e.at };
  const by = byWhom(e, names.people);
  switch (e.kind) {
    case "record.created": {
      const via = String(e.properties.via ?? "");
      return {
        ...base,
        kind: "created",
        text: "Added by hand",
        detail: by ? `By ${by}${via === "palette" ? ", from ⌘K" : via === "vizzy" ? ", from Vizzy's draft" : ""}` : null,
      };
    }
    case "consent.recorded": {
      const p = e.properties as { how?: string; note?: string | null; recordedBy?: string; state?: string };
      if (p.state !== "granted") return { ...base, kind: "consent", text: "Withdrew from marketing emails", detail: null };
      return {
        ...base,
        kind: "consent",
        text: "Agreed to marketing emails",
        detail: `${consentWayLabel(p.how ?? "")}${p.note ? `: ${p.note}` : ""}. Recorded by ${memberLabel(p.recordedBy, names.people)}`,
      };
    }
    case "record.field_changed": {
      const fieldId = e.fieldId ?? "";
      const move = parseMoveFieldId(fieldId);
      const { before, after } = e.properties as { before: unknown; after: unknown };
      if (move) {
        const product = names.products.get(move.on) ?? "a product";
        const launch = names.launches.get(move.on) ?? "a launch";
        switch (move.kind) {
          case "stage":
            // A first stage comes with starting to use the product, and a last with leaving it: those entries say it.
            if (before == null || after == null) return null;
            return { ...base, kind: "stage", text: `Moved from ${STAGE[String(before)] ?? before} to ${STAGE[String(after)] ?? after} in ${product}`, detail: "From your product" };
          case "product":
            return { ...base, kind: "product", text: after === true ? `Started using ${product}` : `No longer in ${product}`, detail: "From your product" };
          case "quiet":
            return { ...base, kind: "quiet", text: after === true ? `Went quiet in ${product}` : `Active again in ${product}`, detail: "From your product" };
          case "launch":
            // Joining a launch shows as their sign-up.
            if (after === true && launchesJoined.has(move.on)) return null;
            return { ...base, kind: "launch", text: after === true ? `Joined ${launch}` : `Left ${launch}`, detail: null };
        }
      }
      if (fieldId.startsWith("sys.")) return null;
      const field = names.fields.get(fieldId);
      const label = field?.label ?? "A field no longer in use";
      const undo = (e.properties as { source?: unknown }).source === "undo";
      const detail = undo
        ? by
          ? `${by} undid Vizzy's suggestion`
          : "Vizzy's suggestion undone"
        : e.agentActionId
          ? by && by !== "Vizzy"
            ? `${by} confirmed Vizzy's suggestion`
            : "Vizzy's suggestion"
          : by
            ? `By ${by}`
            : null;
      if (e.blankedAt) return { ...base, kind: "field", text: `${label} changed`, detail: "Its values went when the field was erased" };
      if (before == null && after == null) return null;
      const text =
        before == null
          ? `${label} set to ${fieldValueText(field, after, names.people)}`
          : after == null
            ? `${label} cleared`
            : `${label} changed from ${fieldValueText(field, before, names.people)} to ${fieldValueText(field, after, names.people)}`;
      return { ...base, kind: "field", text, detail };
    }
    case "agent.proposed":
      // A New person draft: filled in for them before they were added.
      if (e.properties.action === "new_person.draft") return { ...base, kind: "agent", text: "Vizzy filled in New person for them", detail: "Nobody is added until an admin confirms" };
      return { ...base, kind: "agent", text: "Vizzy suggested a change", detail: "Nothing changes until someone confirms" };
    case "agent.declined":
      return { ...base, kind: "agent", text: "A suggestion from Vizzy was set aside", detail: null };
    case "agent.undone":
      return { ...base, kind: "agent", text: "A change was undone", detail: by ? `By ${by}` : null };
    default:
      // agent.approved and agent.acted: the field change they made says it.
      return null;
  }
}

function emailEntry(m: ContactEmailHistoryEntry): TimelineEntry | null {
  const at = m.clickedAt ?? m.openedAt ?? m.sentAt;
  if (!at) return null;
  const subject = m.subject ? `"${m.subject}"` : "a launch email";
  const text = m.clicked ? `Clicked a link in ${subject}` : m.opened ? `Opened ${subject}` : m.bounced ? `${m.subject ? subject : "A launch email"} bounced` : `Sent ${subject}`;
  return { id: `email:${m.journeyId}:${m.nodeId}:${m.signupId}:${m.variantId}`, at, kind: "email", text, detail: "Launch email" };
}

/** Their sign-ups, launch emails and voice chats: the entries that live outside the event history. */
async function besideEntries(ctx: TenantContext, contact: Contact, names: Names, db?: FirestoreLike): Promise<TimelineEntry[]> {
  const repo = forTenant(ctx, db);
  const links = (contact.campaigns ?? []).filter((l) => l.status !== "deleted").slice(0, BESIDE_MAX);
  const [emails, signups] = await Promise.all([
    getContactEmailHistory(ctx, contact, db).catch(() => [] as ContactEmailHistoryEntry[]),
    Promise.all(links.map((l) => repo.signups.getById(l.signupId).catch(() => null))),
  ]);
  const out: TimelineEntry[] = [];
  for (const l of links) {
    const launch = names.launches.get(l.campaignId) ?? "a launch";
    out.push({
      id: `signup:${l.signupId}`,
      at: l.joinedAt,
      kind: "signup",
      text: `Joined the ${launch} waitlist`,
      detail: [l.joinedVia === "site" ? "From your site" : null, LAUNCH_STATUS[l.status] ?? null].filter(Boolean).join(". ") || null,
    });
  }
  for (const s of signups) {
    const chat = s?.aiConversation;
    if (!s || !chat?.completed || !chat.capturedAt) continue;
    out.push({ id: `voice:${s.id}`, at: chat.capturedAt, kind: "voice_chat", text: `Voice chat on the ${names.launches.get(s.campaignId) ?? "launch"} sign-up page`, detail: null, signupId: s.id });
  }
  for (const m of emails.slice(0, BESIDE_MAX)) {
    const e = emailEntry(m);
    if (e) out.push(e);
  }
  // One form of time, so they order with the event history's.
  return out.flatMap((e) => {
    const ms = Date.parse(e.at);
    return Number.isFinite(ms) ? [{ ...e, at: new Date(ms).toISOString() }] : [];
  });
}

/** Names for what this page's entries mention: launches, products, fields and team members. */
async function namesFor(ctx: TenantContext, contact: Contact, events: readonly StoredEvent[], db: FirestoreLike | undefined, lookup?: UserLookup): Promise<Names> {
  const repo = forTenant(ctx, db);
  const launchIds = new Set((contact.campaigns ?? []).map((c) => c.campaignId));
  const productIds = new Set((contact.products ?? []).map((p) => p.connectionId));
  const people = new Set<string>();
  let userFields = false;
  for (const e of events) {
    const move = e.fieldId ? parseMoveFieldId(e.fieldId) : null;
    if (move?.kind === "launch") launchIds.add(move.on);
    else if (move) productIds.add(move.on);
    else if (e.kind === "record.field_changed" && e.fieldId && !e.fieldId.startsWith("sys.")) userFields = true;
    if (e.actor.type === "member" && e.actor.id) people.add(e.actor.id);
    const recordedBy = (e.properties as { recordedBy?: unknown }).recordedBy;
    if (typeof recordedBy === "string") people.add(recordedBy);
  }
  const fieldList = userFields ? await readFieldList(ctx, "person", db).catch(() => null) : null;
  const fields = new Map((fieldList?.items ?? []).map((f) => [f.key, f]));
  // Team member values name people too.
  for (const e of events) {
    const f = e.fieldId ? fields.get(e.fieldId) : undefined;
    if (f?.type !== "team_member") continue;
    for (const v of [(e.properties as { before?: unknown }).before, (e.properties as { after?: unknown }).after]) if (typeof v === "string") people.add(v);
  }
  const [campaigns, connections, names] = await Promise.all([
    Promise.all([...launchIds].slice(0, 100).map(async (id) => [id, await repo.campaigns.getById(id).catch(() => null)] as const)),
    Promise.all([...productIds].slice(0, 50).map(async (id) => [id, await repo.productConnections.getById(id).catch(() => null)] as const)),
    teamMemberNames(ctx, [...people], { db, lookup }),
  ]);
  return {
    launches: new Map(campaigns.map(([id, c]) => [id, c?.waitlistName || "a launch"])),
    products: new Map(
      connections.map(([id, c]) => {
        const env = c ? environmentOf(c) : null;
        return [id, c ? `${productNameOf(c)}${env ? ` · ${ENVIRONMENT_LABEL[env]}` : ""}` : "a product"];
      }),
    ),
    fields,
    people: names,
  };
}

/**
 * One page of a person's timeline, or null when there's no such person in this brand. Throws
 * InvalidCursorError for a cursor this file didn't make.
 */
export async function loadPersonTimeline(
  ctx: TenantContext,
  personId: string,
  opts: { cursor?: string | null; limit?: number; db?: FirestoreLike; lookup?: UserLookup } = {},
): Promise<TimelineViewPage | null> {
  if (!isContactPersonId(personId)) return null;
  const after = opts.cursor ? decode(opts.cursor) : null;
  const contact = await forTenant(ctx, opts.db).contacts.getById(personId);
  if (!contact) return null;
  const page = await listPersonEvents(ctx, personId, { cursor: after?.e ?? null, limit: opts.limit ?? TIMELINE_PAGE.default, db: opts.db });
  // This page reaches back to its oldest event while there are older ones, else to the start.
  const lower = page.next ? (page.events.at(-1)?.at ?? null) : null;
  const upper = after?.b ?? null;
  const names = await namesFor(ctx, contact, page.events, opts.db, opts.lookup);
  const joined = new Set((contact.campaigns ?? []).filter((l) => l.status !== "deleted").map((l) => l.campaignId));
  const beside = (await besideEntries(ctx, contact, names, opts.db)).filter((e) => (upper === null || e.at < upper) && (lower === null || e.at >= lower));
  const entries = [...page.events.flatMap((e) => fromEvent(e, names, joined) ?? []), ...beside].sort(
    (a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id),
  );
  return { entries, next: page.next ? encode({ e: page.next, b: lower }) : null };
}
