import {
  JOURNEY_COMPLETED_EVENT,
  LifecycleSettingsSchema,
  type ContentPool,
  type LifecycleDraft,
  type LifecycleEdge,
  type LifecycleNode,
  type LifecycleSettings,
  type PoolItem,
  type WaitConfig,
} from "@/lib/types/lifecycle";

/**
 * The "follow-on" template: a sequence that CONTINUES FROM another journey
 * (LIFECYCLE_JOURNEY_LINKS_ENABLED) — what comes after the 7-day onboarding.
 *
 *   trigger (finished the journey before)
 *    → wait (gap days, on a later day) → Follow-up 1
 *    → wait (gap days, on a later day) → Follow-up 2 …
 *    → exit
 *
 * Its clock starts when the person reaches the end of the journey before, so no
 * wait here counts from sign-up. It sends in that journey's window, from its
 * sender and under its unsubscribe category, so the two read as one sequence.
 * Deterministic structure and placeholder copy; the architect rewrites the copy.
 */

const X_STEP = 260;
export const FOLLOW_ON_POOL = "follow_ups";
export const FOLLOW_ON_MAX_EMAILS = 6;
const DEFAULT_EMAILS = 4;
const DEFAULT_GAP_DAYS = 3;

/**
 * A wait of `days` days that lands ON that day. Emails only go out in each
 * person's send window, at their own minute — and the email before went out a
 * moment after that minute. So a wait of whole days (48 h, 72 h) is always just
 * past the window on the day it's meant for and slips to the next one. Eight
 * hours short, on a later local day, lands on the day asked for.
 */
export function waitOfDays(days: number): WaitConfig {
  return { minHours: Math.max(12, days * 24 - 8), differentLocalDay: true };
}

const hi = "<p>Hi {{user.first_name|there}},</p>";

const ITEMS: PoolItem[] = [
  {
    id: "f1",
    label: "F1 · Getting more from it",
    subject: "Getting more from {{product.name}}",
    previewText: "One thing worth doing this week",
    body: `${hi}\n<p>Now you're up and running, here's one thing worth doing this week.</p>\n{{block.insight}}`,
    format: "branded",
    messageClass: "marketing",
    personalization: "ai_line",
  },
  {
    id: "f2",
    label: "F2 · A habit worth building",
    subject: "A habit worth building, {{user.first_name|there}}",
    body: `${hi}\n<p>The people who get the most from {{product.name}} come back to it little and often. Here's what to look at when you do.</p>\n{{block.insight}}`,
    format: "branded",
    messageClass: "marketing",
    personalization: "ai_line",
  },
  {
    id: "f3",
    label: "F3 · Quick check-in",
    subject: "How's it going with {{product.name}}?",
    body: "Hi {{user.first_name|there}},\n\nYou've been with us a little while now, so I wanted to ask: how's it going?\n\nReply and tell me what's working and what isn't. I read every reply.",
    format: "letter",
    messageClass: "marketing",
    personalization: "none",
  },
  {
    id: "f4",
    label: "F4 · Going further",
    subject: "The next thing to try in {{product.name}}",
    body: `${hi}\n<p>Here's the next thing I'd try.</p>\n{{block.insight}}`,
    format: "branded",
    messageClass: "marketing",
    personalization: "ai_line",
  },
  {
    id: "f5",
    label: "F5 · What's changed",
    subject: "What's changed since you started",
    body: `${hi}\n<p>A quick look at where things stand now.</p>\n{{block.insight}}`,
    format: "branded",
    messageClass: "marketing",
    personalization: "ai_line",
  },
  {
    id: "f6",
    label: "F6 · Here if you need me",
    subject: "Here if you need me, {{user.first_name|there}}",
    body: "Hi {{user.first_name|there}},\n\nThis is the last of these notes from me. If there's anything you'd like a hand with in {{product.name}}, just reply.",
    format: "letter",
    messageClass: "marketing",
    personalization: "none",
  },
];

export interface FollowOnOptions {
  /** How many emails (1–6). */
  emails?: number;
  /** Days between emails, and before the first (1–14). */
  gapDays?: number;
}

/**
 * The settings a journey that continues from another starts with: the trigger,
 * and the earlier journey's send window, sender, category, tracking and About,
 * so both feel like one sequence. `hardStopDays` is left for the caller.
 */
export function followOnSettings(afterJourneyId: string, from: LifecycleSettings | null): LifecycleSettings {
  const base = LifecycleSettingsSchema.parse({});
  return {
    ...base,
    ...(from ? { sendPolicy: { ...from.sendPolicy }, sender: { ...from.sender }, category: { ...from.category }, tracking: { ...from.tracking }, about: { ...from.about } } : {}),
    trigger: { event: JOURNEY_COMPLETED_EVENT, maxEventAgeHours: base.trigger.maxEventAgeHours, afterJourneyId },
  };
}

/** `draft`, started by finishing `afterJourneyId` instead of a product event (`fromName` renames its trigger). */
export function startingAfter(draft: LifecycleDraft, afterJourneyId: string, fromName?: string): LifecycleDraft {
  return {
    ...draft,
    graph: {
      ...draft.graph,
      nodes: draft.graph.nodes.map((n) =>
        n.type === "trigger" && fromName ? { ...n, data: { ...n.data, label: `Finished ${fromName}`.slice(0, 120) } } : n,
      ),
    },
    settings: { ...draft.settings, trigger: { ...draft.settings.trigger, event: JOURNEY_COMPLETED_EVENT, afterJourneyId } },
  };
}

/** Days a sequence of `days` may take before it stops: room for weekends and held emails. */
export function hardStopFor(days: number): number {
  return Math.min(60, days + Math.max(5, Math.ceil((days * 5) / 7)));
}

export function buildFollowOnDraft(a: {
  afterJourneyId: string;
  /** The journey it continues from: its name (for labels) and its settings to carry on. */
  from?: { name: string; settings: LifecycleSettings } | null;
  options?: FollowOnOptions;
}): LifecycleDraft {
  const emails = Math.min(FOLLOW_ON_MAX_EMAILS, Math.max(1, Math.round(a.options?.emails ?? DEFAULT_EMAILS)));
  const gapDays = Math.min(14, Math.max(1, Math.round(a.options?.gapDays ?? DEFAULT_GAP_DAYS)));
  const items = structuredClone(ITEMS.slice(0, emails));

  const nodes: LifecycleNode[] = [];
  const edges: LifecycleEdge[] = [];
  const at = (col: number) => ({ x: col * X_STEP, y: 0 });
  const link = (source: string, target: string) => edges.push({ id: `e_${source}_out_${target}`, source, target, sourceHandle: null });

  nodes.push({ id: "trigger", type: "trigger", position: at(0), data: { label: a.from ? `Finished ${a.from.name}`.slice(0, 120) : "Finished the journey before" } });
  let previous = "trigger";
  items.forEach((item, i) => {
    const n = i + 1;
    const waitId = `wait_${n}`;
    const emailId = `email_${n}`;
    nodes.push(
      {
        id: waitId,
        type: "wait",
        position: at(1 + i * 2),
        data: { label: gapDays === 1 ? "The next day" : `${gapDays} days later`, wait: waitOfDays(gapDays) },
      },
      { id: emailId, type: "email", position: at(2 + i * 2), data: { label: item.label.replace(/^F\d+ · /, ""), poolId: FOLLOW_ON_POOL } },
    );
    link(previous, waitId);
    link(waitId, emailId);
    previous = emailId;
  });
  nodes.push({ id: "exit", type: "exit", position: at(1 + items.length * 2), data: { label: "End" } });
  link(previous, "exit");

  const pools: ContentPool[] = [{ id: FOLLOW_ON_POOL, label: "Follow-ups", items }];
  const settings = followOnSettings(a.afterJourneyId, a.from?.settings ?? null);
  return {
    graph: { nodes, edges },
    pools,
    settings: {
      ...settings,
      sendPolicy: { ...settings.sendPolicy, hardStopDays: hardStopFor(emails * gapDays) },
      // Every email here is marketing, so only people who can get marketing enter.
      entry: { requireMarketingConsent: true },
    },
  };
}
