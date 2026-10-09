import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { loadPersonRecord, type PersonRecord } from "./personRecord";
import { reachText, stageText } from "./personStage";

/**
 * What Vizzy may know about ONE person: their situation, never who they are.
 *
 * It is the person's page with the identity taken out. There is no name, no email
 * address and none of the product's own ids, here or in anything derived from
 * them: a subject line is given as the email's name in its journey (the rendered
 * one can greet them by name), a clicked link as its path without anything that
 * looks like an id, and traits only when the product's catalog declares them.
 * Then EVERY string in the brief — a fact, a brand's name, a reason, a journey's
 * name, a plan — is scrubbed of the person's name, of anything shaped like an
 * email address and of the product's ids, so nothing relies on a field being
 * "safe". A person called May can cost a sentence its "may"; that is the right
 * way round.
 *
 * What is here is still personal data — behaviour tied to one person — so it is
 * read only for the operator who is looking at that person, through the signed
 * chat token, and never stored on our side.
 */

export interface PersonBrief {
  /** Our id for the person: what the person tools take. Not the product's id for them. */
  personId: string;
  product: string;
  /** A Sandbox's test user: made-up data. */
  testUser: boolean;
  today: string;
  timezone: string | null;
  signedUp: string;
  /** When they last used the product; null = the product doesn't say. */
  lastActive: string | null;
  stage: { summary: string; kind: string; stepsDone: number; stepsTotal: number; nextStep: string | null; daysOnStep: number | null; quietDays: number | null };
  canEmail: { can: "yes" | "limited" | "no"; marketing: boolean; why: string | null };
  onboarding: Array<{ step: string; done: boolean; doneOn: string | null }>;
  /** What they have several of (brands, workspaces…), as the product named them. */
  has: Array<{ kind: string; name: string | null; stepsDone: number; stepsTotal: number; facts: Array<{ label: string; value: string }> }>;
  facts: Array<{ label: string; value: string }>;
  traits: Array<{ label: string; value: string }>;
  emails: { sent: number; opened: number; clicked: number; tracked: number };
  journeys: Array<{
    journeyId: string;
    name: string;
    status: "active" | "completed" | "exited";
    mode: "test" | "shadow" | "live";
    entered: string;
    ended: string | null;
    /** Why it stopped, or what it's held by, in plain words. */
    stopped: string | null;
    held: string | null;
    sent: Array<{
      email: string;
      on: string;
      /** Null when that email couldn't tell us (tracking was off). */
      opened: boolean | null;
      clicked: boolean | null;
      clickedPath: string | null;
      /** `ai`: the reviewed AI line went out. `standard`: the standard wording did. Null: the email has no AI line. */
      wording: "ai" | "standard" | null;
      aiLine: string | null;
      note: string | null;
    }>;
    /** What the sender does next, on the state the product last sent: it can change when they do something. */
    ahead: Array<{ email: string; on: string; willSend: boolean; why: string | null; hasAiLine: boolean }>;
    /** What comes after the emails ahead: "finishes", or "stops: <why>". Null when it's further off than we look. */
    then: string | null;
  }>;
  /** AI lines for this person waiting for staff in Approvals. */
  approvalsWaiting: number;
  /**
   * Their plan, while plans are on: the one staff approved (it steers their AI line) and the
   * draft still waiting for a decision. Absent while plans are off.
   */
  plan?: { inForce: PlanView | null; draft: PlanView | null };
}

type PlanView = { goal: string; angle: string; next: string[]; reviewOn: string | null; writtenBy: "agent" | "human" };

const date = (iso: string | null | undefined) => (iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString().slice(0, 10) : null);

const EMAIL_LIKE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Takes the person out of a string: their name and the name part of their address (each part of
 * either, three letters or more, as a whole word), anything shaped like an email address, and
 * the product's own ids for them and for what they have, wherever one is quoted. A surname in a
 * brand's name goes too: better a gap than a name.
 */
export function identityScrubber(person: { name?: string | null; email?: string | null; ids?: ReadonlyArray<string | null | undefined> }): (value: string) => string {
  const whole = (w: string, edge: string) => new RegExp(`(?<![${edge}])${escapeRe(w)}(?![${edge}])`, "giu");
  const longestFirst = (list: string[]) => [...new Set(list)].sort((a, b) => b.length - a.length);
  const local = (person.email ?? "").split("@")[0] ?? "";
  const parts = [...(person.name ?? "").split(/[\s.\-_']+/), local, ...local.split(/[._\-+]+/)].map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 3);
  // Longest first, so "jo.okafor" goes whole before "okafor" does.
  const words = longestFirst(parts).map((w) => whole(w, "\\p{L}\\p{N}"));
  // An id that reads as an ordinary word ("main", "default") names nobody, and would take that word out of everything.
  const ids = longestFirst((person.ids ?? []).filter((id): id is string => !!id && (/\d/.test(id) || id.length >= 12))).map((id) => whole(id, "\\p{L}\\p{N}_"));
  return (value) => {
    const noIds = ids.reduce((out, re) => out.replace(re, "[id]"), value.replace(EMAIL_LIKE, "[email]"));
    return words.reduce((out, re) => out.replace(re, "[name]"), noIds);
  };
}

/**
 * A clicked link as a path Vizzy can read: no query or fragment (they can carry ids and
 * addresses), and any part of the path that looks like an id rather than a page is left out.
 */
function pathOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const path = u.pathname
      .split("/")
      .map((part) => (/\d/.test(part) || part.length > 24 ? ":id" : part))
      .join("/");
    return `${u.host}${path}`.slice(0, 120);
  } catch {
    return null;
  }
}

/** Fields that are ours alone: ids we made, dates, and fixed words the agent's prompt names. */
const OURS = new Set(["personId", "journeyId", "today", "signedUp", "lastActive", "timezone", "kind", "status", "mode", "wording", "on", "entered", "ended", "doneOn", "reviewOn", "can", "writtenBy"]);

/** Every other string in the brief goes through the scrubber, whoever wrote it: nothing relies on a field being "safe". */
function scrubAll<T>(value: T, scrub: (s: string) => string, key = ""): T {
  if (typeof value === "string") return (OURS.has(key) ? value : scrub(value)) as T;
  if (Array.isArray(value)) return value.map((v) => scrubAll(v, scrub, key)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubAll(v, scrub, k)])) as T;
  return value;
}

export function personBrief(p: PersonRecord, nowMs: number): PersonBrief {
  const scrub = identityScrubber({ name: p.name, email: p.email, ids: [p.externalUserId, ...p.entities.map((e) => e.id)] });
  const reach = reachText(p.reach, p.categoryLabels);
  const brief: PersonBrief = {
    personId: p.id,
    product: p.product,
    testUser: p.sandbox,
    today: new Date(nowMs).toISOString().slice(0, 10),
    timezone: p.timezone,
    signedUp: date(p.signedUpAt) ?? "",
    lastActive: date(p.lastActiveAt),
    stage: {
      summary: stageText(p.stage),
      kind: p.stage.kind,
      stepsDone: p.stage.done,
      stepsTotal: p.stage.total,
      nextStep: p.stage.nextStep,
      daysOnStep: p.stage.daysOnStep,
      quietDays: p.stage.quietDays,
    },
    canEmail: { can: p.reach.can, marketing: p.reach.marketing, why: reach.why },
    onboarding: p.steps.map((s) => ({ step: s.label, done: s.done, doneOn: date(s.doneAt) })),
    has: p.entities.map((e) => ({
      kind: e.kind,
      name: e.name,
      stepsDone: e.done,
      stepsTotal: e.total,
      facts: e.facts.map((f) => ({ label: f.label, value: f.value })),
    })),
    facts: p.facts.map((f) => ({ label: f.label, value: f.value })),
    traits: p.traits.filter((t) => t.declared).map((t) => ({ label: t.label, value: t.value.slice(0, 80) })),
    emails: p.emailCounts,
    journeys: p.journeys.map((j) => {
      const mine = p.emails.filter((e) => e.enrolmentId === j.enrolmentId);
      const ahead = j.steps.filter((s) => s.kind === "next" || s.kind === "later" || s.kind === "would_skip");
      return {
        journeyId: j.journeyId,
        name: j.name,
        status: j.status,
        mode: j.mode,
        entered: date(j.enteredAt) ?? "",
        ended: date(j.endedAt),
        stopped: j.stopped,
        held: j.waiting?.why ?? null,
        // Oldest first, as they got them. The name of the email in its journey, never the rendered subject.
        sent: [...mine].reverse().map((e) => ({
          email: e.label,
          on: date(e.at) ?? "",
          opened: e.status === "skipped" ? null : e.tracked.opens || e.clickedAt ? Boolean(e.openedAt || e.clickedAt) : null,
          clicked: e.status === "skipped" ? null : e.tracked.clicks ? Boolean(e.clickedAt) : null,
          clickedPath: pathOf(e.clickUrl),
          wording: e.version === "ai" ? "ai" : e.version === "fallback" ? "standard" : null,
          aiLine: e.line,
          note: e.note,
        })),
        ahead: ahead.map((s) => ({ email: s.label, on: date(s.at) ?? "", willSend: s.kind !== "would_skip", why: s.reason, hasAiLine: s.personalised })),
        then: j.then ? (j.then.why ? `${j.then.kind}: ${j.then.why}` : j.then.kind) : null,
      };
    }),
    approvalsWaiting: p.approvals,
    ...(p.plan ? { plan: { inForce: planView(p.plan.approved), draft: planView(p.plan.draft) } } : {}),
  };
  return scrubAll(brief, scrub);
}

function planView(plan: NonNullable<PersonRecord["plan"]>["draft" | "approved"]): PlanView | null {
  return plan ? { goal: plan.goal, angle: plan.angle, next: plan.next, reviewOn: plan.reviewOn, writtenBy: plan.by } : null;
}

export async function loadPersonBrief(
  ctx: TenantContext,
  personId: string,
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<{ found: true; brief: PersonBrief } | { found: false; erased: boolean }> {
  const nowMs = deps.nowMs ?? Date.now();
  const r = await loadPersonRecord(ctx, personId, { db: deps.db, nowMs });
  if (!r.found) return { found: false, erased: Boolean(r.erasedAt) };
  return { found: true, brief: personBrief(r.person, nowMs) };
}
