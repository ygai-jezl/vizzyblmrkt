/**
 * Email copywriting FRAMEWORKS — the persuasion structure an email node's copy is
 * shaped by (AIDA / PAS / BAB / …). Distinct from src/lib/content/frameworks.ts
 * (CONTENT_FRAMEWORKS = social/blog presentation angles) — email sequences pick from
 * THIS registry. The Create email-copywriter injects the chosen framework's
 * `structureHint` into the generation prompt; each sequence archetype maps to a
 * default framework via the Context-Mapping-Matrix (see sequenceBlueprints.ts).
 *
 * Pure + client-safe (mirrors frameworks.ts / channels.ts).
 */
export interface EmailFramework {
  id: string;
  label: string;
  description: string;
  /** One-line guidance the copywriter applies when writing an email in this framework. */
  structureHint: string;
}

export const EMAIL_FRAMEWORKS: EmailFramework[] = [
  {
    id: "aida",
    label: "AIDA",
    description: "Attention → Interest → Desire → Action.",
    structureHint:
      "Open with an attention hook, build interest with a relevant benefit, create desire with proof/specifics, and end with ONE clear action.",
  },
  {
    id: "pas",
    label: "PAS",
    description: "Problem → Agitate → Solve.",
    structureHint:
      "Name the reader's problem, agitate its cost/pain, then resolve with your solution and a single next step.",
  },
  {
    id: "bab",
    label: "BAB",
    description: "Before → After → Bridge.",
    structureHint:
      "Paint the reader's Before state, contrast the desirable After state, then bridge with how they get there.",
  },
  {
    id: "plain",
    label: "Plain / Low-friction",
    description: "Brief plain-text, conversational, one small ask.",
    structureHint:
      "2-4 short sentences, no formatting, feels personally typed. Make ONE low-friction ask (e.g. a reply, or a 10-minute chat).",
  },
  {
    id: "urgency",
    label: "Urgency / Scarcity",
    description: "A time- or stock-limited nudge to act now.",
    structureHint:
      "Lead with the reason to act now, state one benefit, add a concrete deadline/scarcity line, and end with a single CTA.",
  },
  {
    id: "social-proof",
    label: "Social Proof",
    description: "Reviews, testimonials, stats or FAQs that ease hesitation.",
    structureHint:
      "Lead with a proof element (a review, a stat, an FAQ), tie it directly to the reader's likely hesitation, then a soft CTA.",
  },
  {
    id: "milestone",
    label: "Milestone / Onboarding",
    description: "Informational, activation- and usage-driven.",
    structureHint:
      "Congratulate or confirm, give ONE concrete next step to get value from the product, and link the how-to. Reassure, don't sell.",
  },
  {
    id: "recommendation",
    label: "Recommendation / Upsell",
    description: "A complementary product or upgraded tier offer.",
    structureHint:
      "Anchor on what the reader already has, recommend the complementary item/tier, justify why it fits, and end with a CTA.",
  },
  {
    id: "pattern-interrupt",
    label: "Pattern Interrupt",
    description: "A direct re-engagement question that breaks the silence.",
    structureHint:
      "Open with a direct question about their continued interest, offer high value/an incentive, and make staying (or opting out) trivial.",
  },
];

const EMAIL_FRAMEWORK_IDS = new Set(EMAIL_FRAMEWORKS.map((f) => f.id));
export const DEFAULT_EMAIL_FRAMEWORK = "aida";

export function isEmailFramework(id: string): boolean {
  return EMAIL_FRAMEWORK_IDS.has(id);
}
export function emailFrameworkLabel(id: string): string {
  return EMAIL_FRAMEWORKS.find((f) => f.id === id)?.label ?? id;
}
export function getEmailFramework(id: string): EmailFramework | undefined {
  return EMAIL_FRAMEWORKS.find((f) => f.id === id);
}
