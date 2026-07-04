import type { SequenceType } from "@/lib/types/contentPlan";
import { isEmailFramework } from "@/lib/content/emailFrameworks";

/**
 * The 7 email-sequence BLUEPRINTS — declarative recipes the Create Architect compiles
 * into a canvas graph (trigger → email → wait → email …, with condition splits). The
 * TOPOLOGY here is canonical and rendered deterministically by architectSequence(); a
 * single Gemini call only enriches each email's brief. Each blueprint also carries a
 * `scenarioBrief` (the Context-Mapping-Matrix theme constraints) and a `defaultFramework`
 * (see emailFrameworks.ts) that the per-email copywriter injects into its prompt.
 *
 * Pure + client-safe (the wizard reads labels/hints; the architect reads the steps).
 */
export interface BlueprintStep {
  kind: "trigger" | "email" | "wait" | "condition";
  /** Node role label shown on the canvas (e.g. "Email 1: Welcome & deliver"). */
  label: string;
  /** EMAIL_FRAMEWORKS id — email steps only. */
  framework?: string;
  /** Seed brief line (email steps) — enriched by the architect's Gemini call. */
  theme?: string;
  /** Delay — wait steps only. */
  wait?: { amount: number; unit: "hours" | "days" };
  /** Split config — condition steps only. */
  condition?: { label: string; yesLabel: string; noLabel: string };
  /** Which lane this step sits on. Steps before a condition are "main"; after a
   *  condition, "yes"/"no" attach to the respective branch. */
  branch?: "main" | "yes" | "no";
}

export interface SequenceBlueprint {
  id: SequenceType;
  /** Wizard card title. */
  label: string;
  /** Wizard card subtitle. */
  hint: string;
  /** Context-Mapping-Matrix theme constraints — injected into every email prompt. */
  scenarioBrief: string;
  /** Default email framework for this scenario (per-step frameworks may override). */
  defaultFramework: string;
  steps: BlueprintStep[];
}

const days = (amount: number) => ({ amount, unit: "days" as const });
const hours = (amount: number) => ({ amount, unit: "hours" as const });

export const SEQUENCE_BLUEPRINTS: SequenceBlueprint[] = [
  {
    id: "welcome",
    label: "Welcome Sequence",
    hint: "New signups & lead magnets",
    scenarioBrief:
      "Brand introduction, set expectations for what's coming, and deliver the lead-magnet / signup promise. Warm and welcoming; make a killer first impression.",
    defaultFramework: "aida",
    steps: [
      { kind: "trigger", label: "New signup / lead-magnet download" },
      {
        kind: "email",
        label: "Email 1: Welcome & deliver",
        framework: "aida",
        theme: "Deliver what they signed up for (lead magnet / welcome) and set expectations for the emails to come.",
      },
      { kind: "wait", label: "Wait 1 day", wait: days(1) },
      {
        kind: "email",
        label: "Email 2: Origin story",
        framework: "bab",
        theme: "The origin story — who you are and why they should care.",
      },
      { kind: "wait", label: "Wait 2 days", wait: days(2) },
      {
        kind: "email",
        label: "Email 3: Quick win",
        framework: "aida",
        theme: "A high-value quick win — your best tip or resource — so they get value fast.",
      },
    ],
  },
  {
    id: "lead_nurture",
    label: "Lead Nurturing Sequence",
    hint: "Warm up interested prospects",
    scenarioBrief:
      "Educate the prospect, position the value proposition, and build authority. Lead heavily with value; tackle industry pain points, share case studies, and handle objections.",
    defaultFramework: "pas",
    steps: [
      { kind: "trigger", label: "Showed interest (e.g. attended a webinar)" },
      {
        kind: "email",
        label: "Email 1: Name the pain",
        framework: "pas",
        theme: "Tackle a core industry pain point; educate rather than pitch.",
      },
      { kind: "wait", label: "Wait 2 days", wait: days(2) },
      {
        kind: "email",
        label: "Email 2: Case study",
        framework: "social-proof",
        theme: "Share a relevant case study to build authority.",
      },
      { kind: "wait", label: "Wait 2 days", wait: days(2) },
      {
        kind: "email",
        label: "Email 3: Handle the objection",
        framework: "pas",
        theme: "Surface and handle a common objection; position your product as the solution.",
      },
      { kind: "wait", label: "Wait 3 days", wait: days(3) },
      {
        kind: "email",
        label: "Email 4: Value proposition",
        framework: "aida",
        theme: "Bring it together — the core value proposition and a clear next step.",
      },
    ],
  },
  {
    id: "cold_outbound",
    label: "Cold Outbound Sequence",
    hint: "Book calls from cold prospects",
    scenarioBrief:
      "Direct, problem-centric hooks with a low-friction CTA focused on booking a short call. Must feel 100% personal, not automated — brief plain-text, no heavy formatting.",
    defaultFramework: "plain",
    steps: [
      { kind: "trigger", label: "Prospect added to the outbound list" },
      {
        kind: "email",
        label: "Email 1: The hook",
        framework: "plain",
        theme: "Name a specific problem they likely have and your solution. Personal, plain-text.",
      },
      { kind: "wait", label: "Wait 3 days", wait: days(3) },
      {
        kind: "email",
        label: "Email 2: Social proof",
        framework: "social-proof",
        theme: "Share a case study / social proof relevant to their industry.",
      },
      { kind: "wait", label: "Wait 4 days", wait: days(4) },
      {
        kind: "email",
        label: "Email 3: Low-friction CTA",
        framework: "plain",
        theme: "Ask for a small commitment — e.g. 'Open to a 10-minute chat next Tuesday?'",
      },
      { kind: "wait", label: "Wait 7 days", wait: days(7) },
      {
        kind: "email",
        label: "Email 4: The breakup",
        framework: "plain",
        theme: "A polite breakup — acknowledge the timing might be off and close the loop.",
      },
    ],
  },
  {
    id: "abandoned_cart",
    label: "Abandoned Cart / Browse Sequence",
    hint: "Recover lost carts & browses",
    scenarioBrief:
      "Address the friction that stopped the purchase, handle objections, and drive back to the cart. Use urgency and social proof; always include the cart-recovery link.",
    defaultFramework: "urgency",
    steps: [
      { kind: "trigger", label: "Cart abandoned / pricing viewed then left" },
      { kind: "wait", label: "Wait 1 hour", wait: hours(1) },
      {
        kind: "email",
        label: "Email 1: Gentle reminder",
        framework: "urgency",
        theme: "'Did you forget something?' — a gentle reminder of what's in the cart, with the recovery link.",
      },
      {
        kind: "condition",
        label: "Purchased since?",
        condition: { label: "Purchased since?", yesLabel: "Purchased", noLabel: "Still in cart" },
      },
      {
        kind: "email",
        label: "Thank-you & onboard",
        framework: "milestone",
        branch: "yes",
        theme: "They completed the purchase — thank them and point to the first steps.",
      },
      { kind: "wait", label: "Wait 24 hours", wait: hours(24), branch: "no" },
      {
        kind: "email",
        label: "Email 2: Ease the anxiety",
        framework: "social-proof",
        branch: "no",
        theme: "Answer FAQs or show reviews to ease buying anxiety.",
      },
      { kind: "wait", label: "Wait 48 hours", wait: hours(48), branch: "no" },
      {
        kind: "email",
        label: "Email 3: Incentive",
        framework: "urgency",
        branch: "no",
        theme: "Scarcity or incentive — e.g. free shipping for the next 24 hours.",
      },
    ],
  },
  {
    id: "post_purchase",
    label: "Post-Purchase & Onboarding Sequence",
    hint: "Onboard & reduce churn",
    scenarioBrief:
      "Eliminate buyer's remorse and drive product activation. Informational and milestone-driven; confirm the order, guide usage, and check in to prevent churn.",
    defaultFramework: "milestone",
    steps: [
      { kind: "trigger", label: "Purchase / signup completed" },
      {
        kind: "email",
        label: "Email 1: Receipt & thanks",
        framework: "milestone",
        theme: "Send a receipt and a genuine thank-you; reduce buyer's remorse.",
      },
      { kind: "wait", label: "Wait 1 day", wait: days(1) },
      {
        kind: "email",
        label: "Email 2: How to get value",
        framework: "milestone",
        theme: "A short guide on how to use the product and get the first win.",
      },
      { kind: "wait", label: "Wait 5 days", wait: days(5) },
      {
        kind: "email",
        label: "Email 3: Check-in",
        framework: "milestone",
        theme: "Check in a week later — how is it going? Offer help; prevent churn.",
      },
    ],
  },
  {
    id: "upsell",
    label: "Upsell / Cross-Sell Sequence",
    hint: "Grow customer lifetime value",
    scenarioBrief:
      "Increase customer lifetime value with complementary products or an upgraded tier. Anchor every recommendation on what the customer already bought.",
    defaultFramework: "recommendation",
    steps: [
      { kind: "trigger", label: "X days after a successful purchase" },
      {
        kind: "email",
        label: "Email 1: Complementary pick",
        framework: "recommendation",
        theme: "Recommend a complementary product to what they bought (e.g. 'You bought the camera — here are the lenses that fit it perfectly').",
      },
      { kind: "wait", label: "Wait 4 days", wait: days(4) },
      {
        kind: "email",
        label: "Email 2: Upgrade tier",
        framework: "recommendation",
        theme: "Invite them to an upgraded tier; justify the added value for their use case.",
      },
    ],
  },
  {
    id: "win_back",
    label: "Win-Back / Re-engagement Sequence",
    hint: "Re-engage dormant contacts",
    scenarioBrief:
      "Re-engage a subscriber who has gone dark, or cleanly remove them to protect sender reputation. Direct and pattern-interrupting; offer high value/an incentive and validate their subscription status.",
    defaultFramework: "pattern-interrupt",
    steps: [
      { kind: "trigger", label: "No opens / purchases for 60-90 days" },
      {
        kind: "email",
        label: "Email 1: Are you still interested?",
        framework: "pattern-interrupt",
        theme: "'Are you still interested in {{topic}}?' — a direct pattern-interrupt to wake them up.",
      },
      { kind: "wait", label: "Wait 4 days", wait: days(4) },
      {
        kind: "condition",
        label: "Re-engaged?",
        condition: { label: "Re-engaged?", yesLabel: "Re-engaged", noLabel: "Still quiet" },
      },
      {
        kind: "email",
        label: "Welcome back",
        framework: "milestone",
        branch: "yes",
        theme: "They re-engaged — welcome them back with a quick win to pick up where they left off.",
      },
      {
        kind: "email",
        label: "Email 2: Final incentive",
        framework: "urgency",
        branch: "no",
        theme: "A final high-value incentive to stay subscribed.",
      },
      { kind: "wait", label: "Wait 4 days", wait: days(4), branch: "no" },
      {
        kind: "email",
        label: "Email 3: Last call",
        framework: "plain",
        branch: "no",
        theme: "Last email — we'll stop emailing unless you click. Clean, respectful list hygiene.",
      },
    ],
  },
];

const BLUEPRINT_BY_ID = new Map(SEQUENCE_BLUEPRINTS.map((b) => [b.id, b]));

export function getSequenceBlueprint(id: string): SequenceBlueprint | undefined {
  return BLUEPRINT_BY_ID.get(id as SequenceType);
}
export function sequenceLabel(id: string): string {
  return BLUEPRINT_BY_ID.get(id as SequenceType)?.label ?? id;
}
export function isSequenceType(id: string): boolean {
  return BLUEPRINT_BY_ID.has(id as SequenceType);
}

/** Dev sanity — every email step names a real framework. Not called at runtime. */
export function _validateBlueprints(): string[] {
  const errors: string[] = [];
  for (const bp of SEQUENCE_BLUEPRINTS) {
    if (!bp.steps.some((s) => s.kind === "trigger")) errors.push(`${bp.id}: no trigger`);
    if (!bp.steps.some((s) => s.kind === "email")) errors.push(`${bp.id}: no email`);
    for (const s of bp.steps) {
      if (s.kind === "email" && s.framework && !isEmailFramework(s.framework)) {
        errors.push(`${bp.id}: unknown framework "${s.framework}"`);
      }
    }
  }
  return errors;
}
