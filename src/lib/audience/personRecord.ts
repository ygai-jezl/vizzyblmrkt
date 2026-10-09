import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { EmailEvent } from "@/lib/types/emailEvent";
import type { EmailSuppression } from "@/lib/types/emailSuppression";
import type { LifecycleEnrolment, LifecycleJourney, LifecycleVersion } from "@/lib/types/lifecycle";
import type { ConnectionCatalog, ProductConnection } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import type { PersonPlan } from "@/lib/types/personPlan";
import { formatFactDate } from "@/lib/connect/dateFacts";
import { ENVIRONMENT_LABEL, environmentOf, productNameOf } from "@/lib/connect/environments";
import { kindLabel, onboardingProgress, progressOf } from "@/lib/lifecycle/entities";
import { isPersonPlansEnabled } from "./flags";
import { emailCounts, personEmails, type PersonEmail, type PersonEmailCounts } from "./personEmails";
import { personJourney, type PersonJourney } from "./personJourneys";
import { personPlanDocId } from "./personPlans";
import { lastActiveAt, personReach, personStage, type PersonReach, type PersonStage } from "./personStage";
import { personTimeline, type PersonMoment } from "./personTimeline";

/**
 * Everything YouGrow holds about one product user, gathered for their page: who
 * they are, where they are in the product, each journey they're in (with what
 * comes next), every email and what they did with it, and one timeline. Reads
 * only: nothing here asks the product anything or changes a thing.
 */

export interface PersonRecord {
  id: string;
  connectionId: string;
  /** The product's own id for them — what "Add to a journey" and the product's Users tab use. */
  externalUserId: string;
  /** "Fernlight app · Production" */
  product: string;
  sandbox: boolean;
  name: string | null;
  email: string | null;
  timezone: string | null;
  signedUpAt: string;
  /** The last time the product sent us anything about them (not the last time they used it). */
  lastSyncAt: string;
  /** When they last used the product, when it tells us (a `last_active_at` date fact). */
  lastActiveAt: string | null;
  stage: PersonStage;
  reach: PersonReach;
  /** Unsubscribe category key → the name people see, from this product's journeys. */
  categoryLabels: Record<string, string>;
  /** The onboarding checklist, as journeys count it, with when each step was done. */
  steps: Array<{ id: string; label: string; done: boolean; doneAt: string | null }>;
  /** Whose steps count when they're per brand, workspace…: "Acme (+1 brand)". */
  stepsAbout: string | null;
  /** What they have several of. */
  entities: Array<{ id: string; kind: string; name: string | null; role: string | null; done: number; total: number; facts: Array<{ label: string; value: string }> }>;
  facts: Array<{ id: string; label: string; value: string; at: string | null }>;
  /** `declared`: the product's catalog names this trait (the rest arrived unannounced). */
  traits: Array<{ label: string; value: string; declared: boolean }>;
  consent: { basis: string | null; asserted: string | null; at: string | null };
  optOuts: Array<{ text: string; at: string | null }>;
  journeys: PersonJourney[];
  emails: PersonEmail[];
  emailCounts: PersonEmailCounts;
  timeline: PersonMoment[];
  /** AI lines for this person waiting in Approvals. */
  approvals: number;
  /** Active journeys of this product they aren't in, for "Add to a journey". */
  canJoin: Array<{ id: string; name: string; mode: LifecycleJourney["deliveryMode"] }>;
  /** Their signup, when the same address is on one of your waitlists. */
  waitlistContactId: string | null;
  /**
   * Their plan (LIFECYCLE_PERSON_PLANS): the draft waiting for a decision and the one in force.
   * Absent while plans are off; both null when there is none yet.
   */
  plan?: Pick<PersonPlan, "draft" | "approved">;
}

export type PersonLookup = { found: true; person: PersonRecord } | { found: false; erasedAt?: string };

const ENROLMENT_LIMIT = 60;

function productLabel(c: Pick<ProductConnection, "name" | "environment" | "kind">): string {
  const env = environmentOf(c);
  return `${productNameOf(c)}${env ? ` · ${ENVIRONMENT_LABEL[env]}` : ""}`;
}

const nameOf = (u: Pick<ProductUser, "firstName" | "lastName">) => [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || null;

type FactCatalog = Pick<ConnectionCatalog, "facts">;

/** A fact as a person reads it: a date in words, anything else with its unit. */
function factValue(id: string, value: string | number | boolean, catalog: FactCatalog, timeZone: string | null | undefined): string {
  const known = (catalog.facts ?? []).find((f) => f.id === id);
  if (known?.type === "date") return formatFactDate(value, "en-GB", timeZone) ?? String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return `${value}${known?.unit ?? ""}`;
}

/** Unsubscribe category key → label, from the designs that name it. */
function categoryLabelsOf(designs: Array<{ settings: { category: { key: string; label: string } } } | null | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of designs) if (d?.settings.category) out[d.settings.category.key] = d.settings.category.label;
  return out;
}

/** Active entries first (soonest next step first), then the ones that ended, newest first. */
function byRelevance(a: PersonJourney, b: PersonJourney): number {
  if ((a.status === "active") !== (b.status === "active")) return a.status === "active" ? -1 : 1;
  if (a.status === "active") return (a.waiting?.until ?? "9").localeCompare(b.waiting?.until ?? "9");
  return (b.endedAt ?? "").localeCompare(a.endedAt ?? "");
}

const GONE: Pick<LifecycleJourney, "name" | "status" | "tracking"> = { name: "A journey that was deleted", status: "archived", tracking: null };

function journeysAndEmails(a: {
  user: ProductUser;
  connection: ProductConnection;
  enrolments: LifecycleEnrolment[];
  journeys: Map<string, LifecycleJourney>;
  versions: Map<string, LifecycleVersion>;
  events: EmailEvent[];
  nowMs: number;
}): { journeys: PersonJourney[]; emails: PersonEmail[] } {
  const entries = a.enrolments.map((enrolment) => ({
    enrolment,
    journey: { id: enrolment.journeyId, ...(a.journeys.get(enrolment.journeyId) ?? GONE) },
    version: a.versions.get(enrolment.versionId) ?? null,
  }));
  return {
    journeys: entries.map((e) => personJourney({ ...e, user: a.user, connection: a.connection, nowMs: a.nowMs })).sort(byRelevance),
    emails: personEmails(entries, a.events, { firstName: a.user.firstName, productName: a.connection.name }),
  };
}

async function versionsOf(ctx: TenantContext, enrolments: LifecycleEnrolment[], db?: FirestoreLike): Promise<Map<string, LifecycleVersion>> {
  const repo = forTenant(ctx, db).lifecycleVersions;
  const ids = [...new Set(enrolments.map((e) => e.versionId))];
  const found = await Promise.all(ids.map((id) => repo.getById(id).catch(() => null)));
  return new Map(found.flatMap((v) => (v ? [[v.id, v] as const] : [])));
}

export async function loadPersonRecord(ctx: TenantContext, personId: string, deps: { db?: FirestoreLike; nowMs?: number } = {}): Promise<PersonLookup> {
  const repo = forTenant(ctx, deps.db);
  const nowMs = deps.nowMs ?? Date.now();
  const user = await repo.productUsers.getById(personId);
  if (!user) return { found: false };
  if (user.status !== "active") return { found: false, erasedAt: user.deletedAt ?? user.updatedAt };
  const connection = await repo.productConnections.getById(user.connectionId);
  if (!connection) return { found: false };

  // Equality only (no composite index): one person's rows are few, so they're sorted here.
  const plans = isPersonPlansEnabled();
  const [enrolments, events, optOuts, writes, drafts, contacts, productJourneys, plan] = await Promise.all([
    repo.lifecycleEnrolments.find({ where: [["productUserId", "==", user.id]], limit: ENROLMENT_LIMIT }),
    repo.emailEvents.find({ where: [["signupId", "==", user.id]], limit: 1000 }),
    user.emailNormalized ? repo.emailSuppressions.find({ where: [["normalizedEmail", "==", user.emailNormalized]], limit: 50 }) : Promise.resolve([] as EmailSuppression[]),
    repo.productEvents.find({ where: [["productUserId", "==", user.id]], limit: 200 }),
    repo.lifecycleDrafts.find({ where: [["productUserId", "==", user.id]], limit: 30 }),
    user.emailNormalized ? repo.contacts.find({ where: [["contactKey", "==", user.emailNormalized]], limit: 1 }).catch(() => []) : Promise.resolve([]),
    repo.lifecycleJourneys.find({ where: [["connectionId", "==", user.connectionId]], limit: 100 }),
    plans ? repo.personPlans.getById(personPlanDocId(user.id)).catch(() => null) : Promise.resolve(null),
  ]);
  const versions = await versionsOf(ctx, enrolments, deps.db);
  const journeysById = new Map(productJourneys.map((j) => [j.id, j]));
  const { journeys, emails } = journeysAndEmails({ user, connection, enrolments, journeys: journeysById, versions, events, nowMs });

  const catalog = connection.catalog;
  const categoryLabels = categoryLabelsOf([...productJourneys.map((j) => j.draft), ...versions.values()]);
  const progress = onboardingProgress(user, catalog);
  // A step done on the brand they're setting up is found there, not on the person.
  const focus = progress.focus.map((f) => user.entities?.[f.id]).filter((e) => e !== undefined);
  const doneAt = (stepId: string) => user.steps[stepId]?.doneAt ?? focus.find((e) => e.steps[stepId])?.steps[stepId]?.doneAt ?? null;
  const active = new Set(journeys.filter((j) => j.status === "active").map((j) => j.journeyId));
  const waitlist = contacts.find((c) => c.status !== "deleted");

  return {
    found: true,
    person: {
      id: user.id,
      connectionId: connection.id,
      externalUserId: user.externalUserId,
      product: productLabel(connection),
      sandbox: connection.kind === "sandbox",
      name: nameOf(user),
      email: user.email ?? null,
      timezone: user.timezone ?? null,
      signedUpAt: user.signedUpAt ?? user.firstSeenAt,
      lastSyncAt: user.lastSeenAt,
      lastActiveAt: lastActiveAt(user, catalog),
      stage: personStage(user, catalog, nowMs),
      reach: personReach(user, connection.consentPolicy, optOuts),
      categoryLabels,
      steps: progress.checklist.map((s) => ({ id: s.id, label: s.label, done: s.done, doneAt: s.done ? doneAt(s.id) : null })),
      stepsAbout:
        progress.focus
          .map((f) => {
            const name = f.name ?? `their ${kindLabel(f.kind, catalog)}`;
            return f.others > 0 ? `${name} (+${f.others} ${kindLabel(f.kind, catalog, f.others > 1)})` : name;
          })
          .join(" · ") || null,
      entities: Object.entries(user.entities ?? {}).map(([id, e]) => {
        const { done, total } = progressOf(e, catalog);
        return {
          id,
          kind: kindLabel(e.kind, catalog),
          name: e.name,
          role: e.role,
          done,
          total,
          facts: Object.entries(e.facts ?? {}).map(([factId, f]) => ({
            label: (catalog.facts ?? []).find((c) => c.id === factId)?.label ?? factId,
            value: factValue(factId, f.value, catalog, user.timezone),
          })),
        };
      }),
      facts: Object.entries(user.facts ?? {}).map(([id, f]) => ({
        id,
        label: (catalog.facts ?? []).find((c) => c.id === id)?.label ?? id,
        value: factValue(id, f.value, catalog, user.timezone),
        at: f.at ?? null,
      })),
      traits: Object.entries(user.traits ?? {})
        .filter(([, v]) => v !== null && v !== "")
        .map(([key, v]) => {
          const declared = catalog.traits.find((t) => t.key === key);
          return { label: declared?.label || key, value: String(v), declared: Boolean(declared) };
        }),
      consent: { basis: user.consent?.basis ?? null, asserted: user.consent?.assertedBasis ?? null, at: user.consent?.at ?? null },
      optOuts: optOuts.map((o) => ({
        text:
          o.scope === "category" && o.category
            ? `Opted out of ${categoryLabels[o.category] ?? o.category}`
            : o.reason === "spam"
              ? "Marked an email as spam"
              : o.reason === "hard_bounce"
                ? "Their address bounced"
                : "Unsubscribed from every email",
        at: o.createdAt ?? null,
      })),
      journeys,
      emails,
      emailCounts: emailCounts(emails),
      timeline: personTimeline({ user, catalog, events: writes, journeys, emails, optOuts, categoryLabels }),
      approvals: drafts.filter((d) => d.status === "awaiting_approval").length,
      canJoin: productJourneys
        .filter((j) => j.status === "active" && j.publishedVersion && j.audience?.kind !== "waitlist" && !active.has(j.id))
        .map((j) => ({ id: j.id, name: j.name, mode: j.deliveryMode })),
      waitlistContactId: waitlist?.id ?? null,
      ...(plans ? { plan: { draft: plan?.draft ?? null, approved: plan?.approved ?? null } } : {}),
    },
  };
}

// ---- The list's rows on screen -------------------------------------------------------------

/** What the Product users list adds to a row once it's on screen: their journey, their emails, and opt-outs made in our emails. */
export interface PersonSummary {
  id: string;
  /** The journey that matters now: the active one that runs next, else the one that ended last. */
  journey: {
    name: string;
    status: PersonJourney["status"];
    /** Emails sent so far in it. */
    sent: number;
    next: { label: string; at: string } | null;
    /** Why it's held, or why it stopped. */
    note: string | null;
  } | null;
  /** How many journeys they're in now. */
  activeJourneys: number;
  emails: PersonEmailCounts;
  reach: PersonReach;
}

/** How many rows one summaries request may ask for. */
export const SUMMARY_LIMIT = 60;

async function findIn<T>(find: (chunk: string[]) => Promise<T[]>, values: string[]): Promise<T[]> {
  const unique = [...new Set(values.filter(Boolean))];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += 30) chunks.push(unique.slice(i, i + 30));
  return (await Promise.all(chunks.map(find))).flat();
}

/**
 * Journey, email counts and reach for the people on screen. Looked up 30 at a time with `in`
 * (no index needed), so a page of rows costs a handful of reads, not three per person.
 */
export async function loadPersonSummaries(ctx: TenantContext, personIds: string[], deps: { db?: FirestoreLike; nowMs?: number } = {}): Promise<PersonSummary[]> {
  const repo = forTenant(ctx, deps.db);
  const nowMs = deps.nowMs ?? Date.now();
  const ids = [...new Set(personIds)].slice(0, SUMMARY_LIMIT);
  const users = (await Promise.all(ids.map((id) => repo.productUsers.getById(id).catch(() => null)))).filter((u): u is ProductUser => u?.status === "active");
  if (users.length === 0) return [];

  const [enrolments, events, optOuts, connections, journeys] = await Promise.all([
    findIn((chunk) => repo.lifecycleEnrolments.find({ where: [["productUserId", "in", chunk]], limit: 2000 }), users.map((u) => u.id)),
    findIn((chunk) => repo.emailEvents.find({ where: [["signupId", "in", chunk]], limit: 5000 }), users.map((u) => u.id)),
    findIn((chunk) => repo.emailSuppressions.find({ where: [["normalizedEmail", "in", chunk]], limit: 2000 }), users.map((u) => u.emailNormalized ?? "")),
    Promise.all([...new Set(users.map((u) => u.connectionId))].map((id) => repo.productConnections.getById(id))),
    repo.lifecycleJourneys.find({ limit: 200 }),
  ]);
  const versions = await versionsOf(ctx, enrolments, deps.db);
  const connectionById = new Map(connections.flatMap((c) => (c ? [[c.id, c] as const] : [])));
  const journeysById = new Map(journeys.map((j) => [j.id, j]));

  return users.flatMap((user) => {
    const connection = connectionById.get(user.connectionId);
    if (!connection) return [];
    const mine = journeysAndEmails({
      user,
      connection,
      enrolments: enrolments.filter((e) => e.productUserId === user.id),
      journeys: journeysById,
      versions,
      events: events.filter((e) => e.signupId === user.id),
      nowMs,
    });
    const j = mine.journeys[0];
    const next = j?.steps.find((s) => s.kind === "next");
    return [
      {
        id: user.id,
        journey: j
          ? {
              name: j.name,
              status: j.status,
              sent: j.steps.filter((s) => s.kind === "sent" || s.kind === "unknown").length,
              next: next ? { label: next.label, at: next.at } : null,
              note: j.status === "active" ? (j.waiting?.why ?? null) : j.stopped,
            }
          : null,
        activeJourneys: mine.journeys.filter((x) => x.status === "active").length,
        emails: emailCounts(mine.emails),
        reach: personReach(user, connection.consentPolicy, optOuts.filter((o) => o.normalizedEmail === user.emailNormalized)),
      },
    ];
  });
}
