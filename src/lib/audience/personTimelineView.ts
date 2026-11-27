import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { Contact } from "@/lib/types/contact";
import type { StoredEvent } from "@/lib/types/ontologyEvent";
import type { AgentAction, AgentActionId } from "@/lib/types/agentAction";
import type { EventActor } from "@/lib/ontology/events";
import type { FieldValue, RecordField } from "@/lib/types/recordField";
import { getContactEmailHistory, type ContactEmailHistoryEntry } from "@/lib/crm/emailHistory";
import { ENVIRONMENT_LABEL, environmentOf, productNameOf } from "@/lib/connect/environments";
import { decodeTimelineCursor, InvalidCursorError, listPersonEvents, TIMELINE_PAGE } from "@/lib/ontology/timeline";
import { getAgentAction } from "@/lib/ontology/agentActions";
import { isContactPersonId } from "@/lib/ontology/person";
import { memberLabel, teamMemberNames, type UserLookup } from "@/lib/team/names";
import { readFieldList } from "./fieldList";
import { valueText } from "./fields";
import { consentWayLabel } from "./newPerson";
import { parseMoveFieldId } from "./personMoves";
import { isIdeaWordsEnabled } from "@/lib/ideas/flags";
import { ideaWord, type IdeaWord } from "@/lib/nav/terms";
import { voiceChatDone } from "@/lib/waitlist/voiceChat";
import { RAISE_FOLLOWUP_ACTION } from "@/lib/raise/pipeline/followups";
import { QUIET_AFTER_DAYS } from "@/lib/raise/pipeline/due";
import { TIMELINE_WORDS } from "@/lib/raise/pipeline/words";

/**
 * One person's timeline (AUDIENCE_TIMELINE_ENABLED), newest first, a page at a time: what their
 * event history holds (being added, consent, field changes, their stage, product, launch and
 * quiet moves, Vizzy's suggestions, the investor board's follow-ups) beside their sign-ups, the emails their launches sent and
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

/** What a value that came with them from an earlier record says on the timeline. */
export const FIELD_MOVED_DETAIL = "Came with them from their earlier record";

/** The most of each other source one timeline reads. */
const BESIDE_MAX = 200;

/**
 * Entries at the same moment, in this order down the page: being added before agreeing, a
 * suggestion's step before the change it made, and so on. Ties after that go by id.
 */
export const TIMELINE_KIND_ORDER: readonly TimelineEntry["kind"][] = [
  "created",
  "consent",
  "agent",
  "field",
  "stage",
  "product",
  "quiet",
  "launch",
  "signup",
  "voice_chat",
  "email",
];
const kindRank = (k: TimelineEntry["kind"]) => TIMELINE_KIND_ORDER.indexOf(k);

/** Newest first; at the same moment, TIMELINE_KIND_ORDER, then id. */
export function compareTimelineEntries(a: TimelineEntry, b: TimelineEntry): number {
  return b.at.localeCompare(a.at) || kindRank(a.kind) - kindRank(b.kind) || b.id.localeCompare(a.id);
}

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
  /** A launch's name in the words in use (isIdeaWordsEnabled()), for one that's gone. */
  word: IdeaWord;
  launches: Map<string, string>;
  products: Map<string, string>;
  fields: Map<string, RecordField>;
  people: Record<string, string>;
  /** The agent actions this page's suggestions belong to, as they stand now; null when gone. */
  actions: Map<string, AgentAction | null>;
  now: string;
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

function actorName(a: EventActor | null, people: Record<string, string>): string | null {
  return a?.type === "member" && a.id ? memberLabel(a.id, people) : null;
}

/**
 * What came of a suggestion, for its "Vizzy suggested" entry: the waiting note only while nobody
 * has decided it, else what happened. Null when the suggestion is gone (erased).
 */
function suggestionOutcome(a: AgentAction | null | undefined, names: Names): string | null {
  if (!a) return null;
  if (a.state === "proposed" || a.state === "approved") return a.expiresAt > names.now ? "Nothing changes until someone confirms" : "Expired before anyone decided";
  if (a.state === "acted") {
    const by = actorName(a.actedBy ?? a.decidedBy, names.people);
    return by ? `Confirmed by ${by}` : "Confirmed";
  }
  if (a.state === "undone") {
    const by = actorName(a.undoneBy, names.people);
    return by ? `Confirmed, then undone by ${by}` : "Confirmed, then undone";
  }
  switch (a.declined?.reason) {
    case "dismissed": {
      const by = actorName(a.decidedBy, names.people);
      return by ? `Dismissed by ${by}` : "Dismissed";
    }
    case "expired":
      return "Expired before anyone decided";
    case "stale":
      return "Set aside, as a field changed since";
    case "superseded":
      return "Replaced by a newer suggestion";
    default:
      return "Set aside";
  }
}

/** What came of a New person draft: nobody is added until an admin confirms it. */
function draftOutcome(a: AgentAction | null | undefined, names: Names): string | null {
  if (!a) return null;
  if (a.state === "proposed" || a.state === "approved") return a.expiresAt > names.now ? "Nobody is added until an admin confirms" : "Expired before anyone decided";
  if (a.state === "acted") {
    const by = actorName(a.actedBy ?? a.decidedBy, names.people);
    return by ? `Added by ${by}` : "Added";
  }
  if (a.declined?.reason === "superseded") return "Replaced by a newer draft";
  if (a.declined?.reason === "expired") return "Expired before anyone decided";
  return "Not used";
}

/**
 * What came of a follow-up from the investor or funding board: YouGrow raised it, not Vizzy, so it
 * reads as waiting, followed up, dismissed, set aside or gone. Null when it is gone (erased).
 */
function followUpOutcome(a: AgentAction | null | undefined, names: Names): string | null {
  if (!a) return null;
  if (a.state === "proposed" || a.state === "approved") return a.expiresAt > names.now ? TIMELINE_WORDS.waiting : TIMELINE_WORDS.expired;
  if (a.state === "acted") return TIMELINE_WORDS.followedUp(actorName(a.actedBy ?? a.decidedBy, names.people));
  switch (a.declined?.reason) {
    case "dismissed":
      return TIMELINE_WORDS.dismissed(actorName(a.decidedBy, names.people));
    case "expired":
      return TIMELINE_WORDS.expired;
    default:
      return TIMELINE_WORDS.cleared;
  }
}

/** A follow-up's due reason, from its dedupe key, which outlives its cleared details. */
function followUpWasQuiet(a: AgentAction | null | undefined): boolean | null {
  const due = a?.dedupeKey.split("|")[1];
  return due === "quiet" ? true : due === "next_step" ? false : null;
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
      if (p.state !== "granted")
        return {
          ...base,
          kind: "consent",
          text: "Withdrew from marketing emails",
          detail: `${p.note ? `${p.note}. ` : ""}Recorded by ${memberLabel(p.recordedBy, names.people)}`,
        };
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
        const launch = names.launches.get(move.on) ?? names.word.a;
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
      const source = (e.properties as { source?: unknown }).source;
      if (source === "sync") {
        // A value that came with them from the record they moved from. Its clearing on that record
        // is bookkeeping, and a merge brings it here too, so it isn't shown.
        if (e.blankedAt || before != null || after == null) return null;
        return { ...base, kind: "field", text: `${label} set to ${fieldValueText(field, after, names.people)}`, detail: FIELD_MOVED_DETAIL };
      }
      const undo = source === "undo";
      const fromFollowUp = !!e.agentActionId && names.actions.get(e.agentActionId)?.action === RAISE_FOLLOWUP_ACTION;
      const detail = fromFollowUp
        ? TIMELINE_WORDS.fromFollowUp(by)
        : undo
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
      // A follow-up from the investor or funding board: YouGrow's rule raised it, not Vizzy.
      if (e.properties.action === RAISE_FOLLOWUP_ACTION) {
        const a = names.actions.get(e.agentActionId ?? "");
        const quiet = followUpWasQuiet(a);
        return {
          ...base,
          kind: "agent",
          text: quiet === false ? TIMELINE_WORDS.proposedNextStep : TIMELINE_WORDS.proposedQuiet(QUIET_AFTER_DAYS),
          detail: followUpOutcome(a, names),
        };
      }
      // A New person draft: filled in for them before they were added.
      // Each says what came of it once someone decided, read from the action as it stands now.
      if (e.properties.action === "new_person.draft")
        return { ...base, kind: "agent", text: "Vizzy filled in New person for them", detail: draftOutcome(names.actions.get(e.agentActionId ?? ""), names) };
      return { ...base, kind: "agent", text: "Vizzy suggested a change", detail: suggestionOutcome(names.actions.get(e.agentActionId ?? ""), names) };
    case "agent.declined":
      if (e.properties.action === RAISE_FOLLOWUP_ACTION) return { ...base, kind: "agent", text: TIMELINE_WORDS.declined, detail: null };
      return { ...base, kind: "agent", text: "A suggestion from Vizzy was set aside", detail: null };
    case "agent.undone":
      return { ...base, kind: "agent", text: "A change was undone", detail: by ? `By ${by}` : null };
    default:
      // agent.approved and agent.acted: the field change they made says it.
      return null;
  }
}

/** An email a launch sent them. While launches are called ideas it is a waitlist email: "an idea email" reads oddly. */
function emailEntry(m: ContactEmailHistoryEntry, word: IdeaWord): TimelineEntry | null {
  const at = m.clickedAt ?? m.openedAt ?? m.sentAt;
  if (!at) return null;
  const ideas = word.one === "idea";
  const subject = m.subject ? `"${m.subject}"` : ideas ? "a waitlist email" : "a launch email";
  const unnamed = ideas ? "A waitlist email" : "A launch email";
  const text = m.clicked ? `Clicked a link in ${subject}` : m.opened ? `Opened ${subject}` : m.bounced ? `${m.subject ? subject : unnamed} bounced` : `Sent ${subject}`;
  return { id: `email:${m.journeyId}:${m.nodeId}:${m.signupId}:${m.variantId}`, at, kind: "email", text, detail: ideas ? "Waitlist email" : "Launch email" };
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
    const launch = names.launches.get(l.campaignId);
    out.push({
      id: `signup:${l.signupId}`,
      at: l.joinedAt,
      kind: "signup",
      // One that's gone has no name to put in the sentence.
      text: launch && launch !== names.word.a ? `Joined the ${launch} waitlist` : "Joined a waitlist",
      detail: [l.joinedVia === "site" ? "From your site" : null, LAUNCH_STATUS[l.status] ?? null].filter(Boolean).join(". ") || null,
    });
  }
  for (const s of signups) {
    const chat = s?.aiConversation;
    if (!s || !chat || !voiceChatDone(chat) || !chat.capturedAt) continue;
    out.push({ id: `voice:${s.id}`, at: chat.capturedAt, kind: "voice_chat", text: `Voice chat on the ${names.launches.get(s.campaignId) ?? names.word.one} sign-up page`, detail: null, signupId: s.id });
  }
  for (const m of emails.slice(0, BESIDE_MAX)) {
    const e = emailEntry(m, names.word);
    if (e) out.push(e);
  }
  // One form of time, so they order with the event history's.
  return out.flatMap((e) => {
    const ms = Date.parse(e.at);
    return Number.isFinite(ms) ? [{ ...e, at: new Date(ms).toISOString() }] : [];
  });
}

/**
 * The agent actions behind this page's suggestions, and behind its field changes that one decided
 * (so a follow-up's change reads as one), as they stand now (null when gone).
 */
async function suggestionActions(ctx: TenantContext, events: readonly StoredEvent[], db: FirestoreLike | undefined): Promise<Map<string, AgentAction | null>> {
  const ids = [...new Set(events.flatMap((e) => ((e.kind === "agent.proposed" || e.kind === "record.field_changed") && e.agentActionId ? [e.agentActionId] : [])))];
  const rows = await Promise.all(ids.map(async (id) => [id, await getAgentAction(ctx, id as AgentActionId, { db }).catch(() => null)] as const));
  return new Map(rows);
}

/** Names for what this page's entries mention: launches, products, fields, team members and suggestions. */
async function namesFor(ctx: TenantContext, contact: Contact, events: readonly StoredEvent[], db: FirestoreLike | undefined, lookup: UserLookup | undefined, nowMs: number): Promise<Names> {
  const repo = forTenant(ctx, db);
  const actions = await suggestionActions(ctx, events, db);
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
  // Who decided each suggestion.
  for (const a of actions.values()) for (const who of [a?.actedBy, a?.decidedBy, a?.undoneBy]) if (who?.type === "member" && who.id) people.add(who.id);
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
  const word = ideaWord(isIdeaWordsEnabled());
  return {
    word,
    launches: new Map(campaigns.map(([id, c]) => [id, c?.waitlistName || word.a])),
    products: new Map(
      connections.map(([id, c]) => {
        const env = c ? environmentOf(c) : null;
        return [id, c ? `${productNameOf(c)}${env ? ` · ${ENVIRONMENT_LABEL[env]}` : ""}` : "a product"];
      }),
    ),
    fields,
    people: names,
    actions,
    now: new Date(nowMs).toISOString(),
  };
}

/**
 * One page of a person's timeline, or null when there's no such person in this brand. Throws
 * InvalidCursorError for a cursor this file didn't make.
 */
export async function loadPersonTimeline(
  ctx: TenantContext,
  personId: string,
  opts: { cursor?: string | null; limit?: number; db?: FirestoreLike; lookup?: UserLookup; nowMs?: number } = {},
): Promise<TimelineViewPage | null> {
  if (!isContactPersonId(personId)) return null;
  const after = opts.cursor ? decode(opts.cursor) : null;
  const contact = await forTenant(ctx, opts.db).contacts.getById(personId);
  if (!contact) return null;
  const page = await listPersonEvents(ctx, personId, { cursor: after?.e ?? null, limit: opts.limit ?? TIMELINE_PAGE.default, db: opts.db });
  // This page reaches back to where the event read stopped while there are older ones, else to the
  // start: the cursor's own time, which counts rows that didn't parse, so a page of unreadable rows
  // still bounds what else it shows.
  const lower = page.next ? (decodeTimelineCursor(page.next)?.at ?? page.events.at(-1)?.at ?? null) : null;
  const upper = after?.b ?? null;
  const names = await namesFor(ctx, contact, page.events, opts.db, opts.lookup, opts.nowMs ?? Date.now());
  const joined = new Set((contact.campaigns ?? []).filter((l) => l.status !== "deleted").map((l) => l.campaignId));
  const beside = (await besideEntries(ctx, contact, names, opts.db)).filter((e) => (upper === null || e.at < upper) && (lower === null || e.at >= lower));
  const entries = [...page.events.flatMap((e) => fromEvent(e, names, joined) ?? []), ...beside].sort(compareTimelineEntries);
  return { entries, next: page.next ? encode({ e: page.next, b: lower }) : null };
}
