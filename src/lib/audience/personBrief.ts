import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { loadPersonRecord, type PersonRecord } from "./personRecord";
import { reachText, stageText } from "./personStage";

/**
 * What Vizzy may know about ONE person: their situation, never who they are.
 *
 * It is the person's page with the identity taken out. There is no name, no email
 * address and none of the product's own ids, here or in anything derived from
 * them: a subject line is given as the email's name in its journey (the rendered
 * one can greet them by name), a clicked link as its path alone, and every value
 * a product supplied (a fact, a brand's name, a trait, a reason) is scrubbed of
 * the person's name and of anything shaped like an email address before it
 * leaves. Traits are included only when the product's catalog declares them.
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
    then: "finishes" | "stops" | null;
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
 * Takes the person out of a value a product supplied: their name and the name part of their
 * address (each part of either, three letters or more, as a whole word), and anything shaped
 * like an email address. A surname in a brand's name goes too: better a gap than a name.
 */
export function identityScrubber(person: { name?: string | null; email?: string | null }): (value: string) => string {
  const local = (person.email ?? "").split("@")[0] ?? "";
  const parts = [...(person.name ?? "").split(/[\s.\-_']+/), local, ...local.split(/[._\-+]+/)].map((w) => w.trim()).filter((w) => w.length >= 3);
  // Longest first, so "jo.okafor" goes whole before "okafor" does.
  const words = [...new Set(parts.map((w) => w.toLowerCase()))]
    .sort((a, b) => b.length - a.length)
    .map((w) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(w)}(?![\\p{L}\\p{N}])`, "giu"));
  return (value) => words.reduce((out, re) => out.replace(re, "[name]"), value.replace(EMAIL_LIKE, "[email]"));
}

/** A clicked link as a path: the query and fragment can carry ids and addresses. */
function pathOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.slice(0, 120);
  } catch {
    return null;
  }
}

export function personBrief(p: PersonRecord, nowMs: number): PersonBrief {
  const scrub = identityScrubber(p);
  const opt = (s: string | null) => (s === null ? null : scrub(s));
  const reach = reachText(p.reach, p.categoryLabels);
  return {
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
    canEmail: { can: p.reach.can, marketing: p.reach.marketing, why: opt(reach.why) },
    onboarding: p.steps.map((s) => ({ step: s.label, done: s.done, doneOn: date(s.doneAt) })),
    has: p.entities.map((e) => ({
      kind: e.kind,
      name: opt(e.name),
      stepsDone: e.done,
      stepsTotal: e.total,
      facts: e.facts.map((f) => ({ label: f.label, value: scrub(f.value) })),
    })),
    facts: p.facts.map((f) => ({ label: f.label, value: scrub(f.value) })),
    traits: p.traits.filter((t) => t.declared).map((t) => ({ label: t.label, value: scrub(t.value).slice(0, 80) })),
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
        stopped: opt(j.stopped),
        held: opt(j.waiting?.why ?? null),
        // Oldest first, as they got them. The name of the email in its journey, never the rendered subject.
        sent: [...mine].reverse().map((e) => ({
          email: e.label,
          on: date(e.at) ?? "",
          opened: e.status === "skipped" ? null : e.tracked.opens || e.clickedAt ? Boolean(e.openedAt || e.clickedAt) : null,
          clicked: e.status === "skipped" ? null : e.tracked.clicks ? Boolean(e.clickedAt) : null,
          clickedPath: pathOf(e.clickUrl),
          wording: e.version === "ai" ? "ai" : e.version === "fallback" ? "standard" : null,
          aiLine: opt(e.line),
          note: e.note,
        })),
        ahead: ahead.map((s) => ({ email: s.label, on: date(s.at) ?? "", willSend: s.kind !== "would_skip", why: s.reason, hasAiLine: s.personalised })),
        then: j.then?.kind ?? null,
      };
    }),
    approvalsWaiting: p.approvals,
    ...(p.plan ? { plan: { inForce: planView(p.plan.approved), draft: planView(p.plan.draft) } } : {}),
  };
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
