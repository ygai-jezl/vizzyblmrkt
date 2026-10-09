import type { ConnectionCatalog } from "@/lib/types/productConnection";
import type { EmailSuppression } from "@/lib/types/emailSuppression";
import type { ProductEvent } from "@/lib/types/productEvent";
import type { ProductUser } from "@/lib/types/productUser";
import { RESERVED_EVENTS } from "@/lib/connect/protocol";
import { kindLabel } from "@/lib/lifecycle/entities";
import type { PersonEmail } from "./personEmails";
import type { PersonJourney } from "./personJourneys";

/**
 * One person's story, newest first: what they did in the product, what they were
 * sent and what they did with it, in one list. Built from what is already held;
 * raw product events only go back 90 days, steps and first milestones further. Pure.
 */

export interface PersonMoment {
  at: string;
  /** `product`: something they did in the product. `email`: sent, opened, clicked. `journey`: entered, finished, left. `stop`: a bounce, complaint or opt-out. */
  kind: "product" | "email" | "journey" | "stop";
  text: string;
  detail: string | null;
}

export const TIMELINE_LIMIT = 120;

/** Events that say what a step or the sign-up already says. */
const QUIET_EVENTS = new Set<string>([
  RESERVED_EVENTS.signedUp,
  RESERVED_EVENTS.stepCompleted,
  RESERVED_EVENTS.onboardingCompleted,
  RESERVED_EVENTS.preferencesUpdated,
  RESERVED_EVENTS.marketingConsentGranted,
  RESERVED_EVENTS.entityCreated,
]);

const OPT_OUT_TEXT: Record<EmailSuppression["reason"], string> = {
  unsubscribe: "Unsubscribed from every email",
  spam: "Marked an email as spam",
  hard_bounce: "Their address bounced",
};

export function personTimeline(a: {
  user: Pick<ProductUser, "signedUpAt" | "firstSeenAt" | "steps" | "entities" | "milestones" | "activatedAt" | "emailPreferences">;
  catalog: Pick<ConnectionCatalog, "onboardingSteps" | "events"> & Partial<Pick<ConnectionCatalog, "entityKinds">>;
  /** The product's writes we still hold (90 days): each `track` is something they did. */
  events: ReadonlyArray<Pick<ProductEvent, "type" | "event" | "timestamp" | "applied" | "entityId">>;
  journeys: readonly PersonJourney[];
  emails: readonly PersonEmail[];
  optOuts: ReadonlyArray<Pick<EmailSuppression, "scope" | "reason" | "createdAt"> & { category?: string | null }>;
  categoryLabels?: Record<string, string>;
}): PersonMoment[] {
  const { user, catalog } = a;
  const out: PersonMoment[] = [];
  const add = (at: string | null | undefined, kind: PersonMoment["kind"], text: string, detail: string | null = null) => {
    if (at && Number.isFinite(Date.parse(at))) out.push({ at, kind, text, detail });
  };
  const stepLabel = (id: string) => catalog.onboardingSteps.find((s) => s.id === id)?.label ?? id;
  const eventLabel = (name: string) => catalog.events.find((e) => e.name === name)?.label || name;
  const category = (key: string) => a.categoryLabels?.[key] ?? key;

  add(user.signedUpAt ?? user.firstSeenAt, "product", "Signed up");
  for (const [id, s] of Object.entries(user.steps ?? {})) add(s.doneAt, "product", `Finished ${stepLabel(id)}`);
  for (const e of Object.values(user.entities ?? {})) {
    const kind = kindLabel(e.kind, { onboardingSteps: catalog.onboardingSteps, entityKinds: catalog.entityKinds });
    add(e.firstSeenAt, "product", `Added ${kind}${e.name ? ` ${e.name}` : ""}`);
    for (const [id, s] of Object.entries(e.steps ?? {})) add(s.doneAt, "product", `Finished ${stepLabel(id)}`, e.name);
  }
  add(user.activatedAt, "product", "Finished onboarding");

  // What they did: each event we still hold, and the first time of any that's older than that.
  const tracks = a.events.filter((e) => e.type === "track" && e.applied && e.event && !QUIET_EVENTS.has(e.event));
  const held = new Set(tracks.map((e) => `${e.event}|${e.timestamp}`));
  for (const e of tracks) add(e.timestamp, "product", eventLabel(e.event!), e.entityId ? (user.entities?.[e.entityId]?.name ?? null) : null);
  for (const [name, m] of Object.entries(user.milestones ?? {})) {
    if (QUIET_EVENTS.has(name) || held.has(`${name}|${m.firstAt}`)) continue;
    add(m.firstAt, "product", eventLabel(name), m.count > 1 ? `${m.count} times in all` : null);
  }

  for (const j of a.journeys) {
    add(j.enteredAt, "journey", `Entered ${j.name}`, j.about);
    if (j.status === "completed") add(j.endedAt, "journey", `Finished ${j.name}`);
    if (j.status === "exited") add(j.endedAt, "journey", `Left ${j.name}`, j.stopped);
  }

  for (const e of a.emails) {
    const name = e.subject ? `"${e.subject}"` : e.label;
    if (e.status === "skipped") add(e.at, "email", `Skipped ${name}`, e.note);
    else add(e.at, "email", `Sent ${name}`, [e.journeyName, e.mode === "live" ? null : `${e.mode} mode`, e.note].filter(Boolean).join(" · "));
    add(e.openedAt, "email", `Opened ${name}`);
    add(e.clickedAt, "email", `Clicked a link in ${name}`, e.clickUrl);
  }

  for (const o of a.optOuts) {
    add(o.createdAt, "stop", o.scope === "category" && o.category ? `Opted out of ${category(o.category)}` : OPT_OUT_TEXT[o.reason]);
  }
  for (const [key, p] of Object.entries(user.emailPreferences ?? {})) {
    if (p.subscribed === false) add(p.at, "stop", `Opted out of ${category(key)} in your product`);
  }

  // Oldest first in the order things happen (signing up, then entering a journey at the same
  // moment), then turned round: two moments at one time read newest-cause first.
  return out
    .sort((x, y) => Date.parse(x.at) - Date.parse(y.at))
    .reverse()
    .slice(0, TIMELINE_LIMIT);
}
