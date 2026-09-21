import type { ConnectionCatalog } from "@/lib/types/productConnection";
import {
  LifecycleSettingsSchema,
  type ContentPool,
  type LifecycleDraft,
  type LifecycleEdge,
  type LifecycleNode,
  type WaitConfig,
} from "@/lib/types/lifecycle";

/**
 * The "product onboarding" template: a post-signup sequence that splits on
 * onboarding progress (the vizzybl.ai 7-day shape, for any connected product).
 *
 *   trigger (user.signed_up)
 *    → wait (15 min; window-exempt for 2h15) → Welcome
 *    → slot 1 (next local business morning)  → onboarding complete? education : reminder
 *    → slot 2 (≥40h later, ≥68h since signup) → education : reminder
 *    → slot 3 (≥40h, ≥116h)                    → education : reminder
 *    → slot 4 (≥40h, ≥164h ≈ day 7)            → week recap : last note
 *    → exit
 *
 * Education and reminders are POOLS: each slot sends the next item the user
 * hasn't had, so someone who finishes onboarding on day five still starts the
 * education series at its first email. Deterministic structure and placeholder
 * copy (merge tokens + dynamic blocks); the architect (M4a) rewrites the copy.
 */

const X_STEP = 260;
const Y_LANE = 150;

function welcomeBody(): string {
  return [
    "<p>Hi {{user.first_name|there}},</p>",
    "<p>Welcome to {{product.name}}. Getting set up takes a few minutes — here's where you are:</p>",
    "{{block.checklist}}",
    "{{block.next_step}}",
    "<p>Reply to this email if anything gets in your way — it comes straight to me.</p>",
  ].join("\n");
}

const pools: ContentPool[] = [
  {
    id: "welcome",
    label: "Welcome",
    items: [
      {
        id: "w",
        label: "W · Welcome",
        subject: "Welcome to {{product.name}}, {{user.first_name|there}}",
        previewText: "Your first steps, and where you are with them",
        body: welcomeBody(),
        format: "branded",
        messageClass: "service",
        personalization: "none",
      },
    ],
  },
  {
    id: "reminders",
    label: "Onboarding reminders",
    items: [
      {
        id: "r1",
        label: "R1 · Next step",
        subject: "Your next step: {{next_step.label}}",
        previewText: "It takes a few minutes",
        body: "<p>Hi {{user.first_name|there}},</p>\n<p>You're one step closer. Here's what's next:</p>\n{{block.next_step}}\n{{block.insight}}\n<p>Stuck? Just reply.</p>",
        format: "letter",
        messageClass: "marketing",
        personalization: "ai_line",
      },
      {
        id: "r2",
        label: "R2 · Almost there",
        subject: "{{user.first_name|You}}, you're nearly set up",
        previewText: "Here's what the next step shows you",
        body: "<p>Hi {{user.first_name|there}},</p>\n<p>Here's your progress so far:</p>\n{{block.checklist}}\n{{block.insight}}\n{{block.next_step}}",
        format: "letter",
        messageClass: "marketing",
        personalization: "ai_line",
      },
      {
        id: "q",
        label: "Q · Quick question",
        subject: "Quick question about {{product.name}}",
        body: "Hi {{user.first_name|there}},\n\nIs something blocking you? Just reply with a number:\n\n1. Not sure where to start\n2. Waiting on a colleague\n3. Not the right time\n4. Something didn't work\n\nI read every reply.",
        format: "letter",
        messageClass: "marketing",
        personalization: "none",
      },
    ],
  },
  {
    id: "education",
    label: "Education",
    items: [
      {
        id: "e1",
        label: "E1 · Reading your results",
        subject: "How to read your first results",
        previewText: "What the numbers mean, and what to do next",
        body: "<p>Hi {{user.first_name|there}},</p>\n<p>You're set up — here's how to read what you're seeing.</p>\n{{block.insight}}",
        format: "branded",
        messageClass: "marketing",
        personalization: "ai_line",
      },
      {
        id: "e2",
        label: "E2 · Where the data comes from",
        subject: "Where your results come from",
        body: "<p>Hi {{user.first_name|there}},</p>\n<p>A quick look behind the numbers.</p>\n{{block.insight}}",
        format: "branded",
        messageClass: "marketing",
        personalization: "ai_line",
      },
      {
        id: "e3",
        label: "E3 · Your first fix",
        subject: "The first thing I'd fix",
        body: "<p>Hi {{user.first_name|there}},</p>\n<p>One change worth making this week.</p>\n{{block.insight}}",
        format: "branded",
        messageClass: "marketing",
        personalization: "ai_line",
      },
    ],
  },
  {
    id: "recap",
    label: "Week recap",
    items: [
      {
        id: "e4",
        label: "E4 · Your first week",
        subject: "Your first week with {{product.name}}",
        body: "<p>Hi {{user.first_name|there}},</p>\n<p>Here's your first week at a glance.</p>\n{{block.insight}}",
        format: "branded",
        messageClass: "marketing",
        personalization: "ai_line",
      },
    ],
  },
  {
    id: "last_note",
    label: "Last note",
    items: [
      {
        id: "l",
        label: "L · Last note",
        subject: "Last note from me, {{user.first_name|there}}",
        body: "<p>Hi {{user.first_name|there}},</p>\n<p>This is my last onboarding email. If you'd still like to get set up, here's the step that unlocks the most:</p>\n{{block.next_step}}\n<p>Reply any time — I'm happy to help.</p>",
        format: "letter",
        messageClass: "marketing",
        personalization: "ai_line",
      },
    ],
  },
];

/** Build the draft. The catalog decides whether the "onboarding complete" branch is usable. */
export function buildProductOnboardingDraft(catalog: ConnectionCatalog): LifecycleDraft {
  const slots: Array<{ wait: WaitConfig; label: string; yes: string; no: string }> = [
    { wait: { minHours: 12, differentLocalDay: true }, label: "Next business morning", yes: "education", no: "reminders" },
    { wait: { minHours: 40, sinceEnrolHours: 68 }, label: "About day 3", yes: "education", no: "reminders" },
    { wait: { minHours: 40, sinceEnrolHours: 116 }, label: "About day 5", yes: "education", no: "reminders" },
    { wait: { minHours: 40, sinceEnrolHours: 164 }, label: "About day 7", yes: "recap", no: "last_note" },
  ];
  const doneBranch = {
    id: "done",
    label: "Onboarding complete",
    match: "all" as const,
    conditions: [{ field: "onboarding.complete", operator: "is_true" as const }],
  };
  const branches = catalog.onboardingSteps.length > 0 ? [doneBranch] : [];

  const nodes: LifecycleNode[] = [];
  const edges: LifecycleEdge[] = [];
  const at = (col: number, lane = 0) => ({ x: col * X_STEP, y: lane * Y_LANE });
  const link = (source: string, target: string, sourceHandle: string | null = null) =>
    edges.push({ id: `e_${source}_${sourceHandle ?? "out"}_${target}`, source, target, sourceHandle });

  nodes.push(
    { id: "trigger", type: "trigger", position: at(0), data: { label: "Signed up" } },
    {
      id: "wait_welcome",
      type: "wait",
      position: at(1),
      data: { label: "15 minutes after sign-up", wait: { minHours: 0.25, windowExemptHours: 2.25 } },
    },
    { id: "email_welcome", type: "email", position: at(2), data: { label: "Welcome", poolId: "welcome" } },
  );
  link("trigger", "wait_welcome");
  link("wait_welcome", "email_welcome");
  link("email_welcome", "wait_1");

  slots.forEach((slot, i) => {
    const n = i + 1;
    const col = 3 + i * 3;
    const waitId = `wait_${n}`;
    const condId = `cond_${n}`;
    const yesId = `email_${slot.yes}_${n}`;
    const noId = `email_${slot.no}_${n}`;
    nodes.push(
      { id: waitId, type: "wait", position: at(col), data: { label: slot.label, wait: slot.wait } },
      { id: condId, type: "condition", position: at(col + 1), data: { label: "Onboarding complete?", branches } },
      { id: yesId, type: "email", position: at(col + 2, -1), data: { label: poolLabel(slot.yes), poolId: slot.yes } },
      { id: noId, type: "email", position: at(col + 2, 1), data: { label: poolLabel(slot.no), poolId: slot.no } },
    );
    link(waitId, condId);
    link(condId, yesId, "done");
    link(condId, noId, "default");
  });
  nodes.push({ id: "exit", type: "exit", position: at(3 + slots.length * 3), data: { label: "End" } });

  // Both lanes of each slot converge on the next slot's wait (or the exit).
  slots.forEach((slot, i) => {
    const next = i < slots.length - 1 ? `wait_${i + 2}` : "exit";
    link(`email_${slot.yes}_${i + 1}`, next);
    link(`email_${slot.no}_${i + 1}`, next);
  });

  return {
    graph: { nodes, edges },
    pools: structuredClone(pools),
    settings: LifecycleSettingsSchema.parse({}),
  };
}

function poolLabel(poolId: string): string {
  return pools.find((p) => p.id === poolId)?.label ?? poolId;
}
