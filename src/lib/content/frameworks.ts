/**
 * Presentation STYLES (frameworks) — HOW a piece of content is shaped. Distinct
 * from blockType (its modular ROLE), category (intent), and channel (where it
 * goes). Each style carries a structureHint + 1+ input→template demonstrations the
 * templatize prompt injects ONLY for the chosen style (keeps the prompt small).
 *
 * Pure + client-safe (mirrors templateCategories.ts).
 */
export interface FrameworkExample {
  input: string;
  template: string;
}
export interface ContentFramework {
  id: string;
  label: string;
  description: string;
  /** One-line guidance the model applies when templatizing in this style. */
  structureHint: string;
  examples: FrameworkExample[];
}

export const CONTENT_FRAMEWORKS: ContentFramework[] = [
  {
    id: "contrarian",
    label: "Contrarian",
    description: "Challenges the status quo — old way vs new way, myth vs truth.",
    structureHint:
      "Set up the common/old approach, reject it, then present the better way as a list or contrast.",
    examples: [
      {
        input:
          "The biggest mistake I made as a beginner writer:\nPracticing In Private\nGoogle Docs are a bad place to start writing.\nInstead, write on:\n- Twitter\n- Medium\n- Quora\n- LinkedIn\nPractice In Public!",
        template:
          "The biggest mistake I made as {{This}}:\n{{Mistake}}\n{{AddContext}}\nInstead, {{Action}}:\n- {{Action1}}\n- {{Action2}}\n- {{Action3}}\n- {{Action4}}\n{{WinningOutcome}}",
      },
    ],
  },
  {
    id: "listicle",
    label: "Listicle",
    description: "A numbered or bulleted list of parallel items under one premise.",
    structureHint:
      "State the premise, then a parallel list where each item shares the same grammatical shape.",
    examples: [
      {
        input:
          "If you are in your 20s, stop screwing around\nDo these 5 things:\n- Choose the gym over Netflix\n- Choose health over fast food\n- Choose meditation over anxiety\n- Start a business on the side\n- Start taking yourself seriously\nYour 20s are meant to BUILD not decay",
        template:
          "If you are {{This}}, stop {{NegativeThing}}\nDo these 5 things:\n- {{Thing}}\n- {{Thing}}\n- {{Thing}}\n- {{Thing}}\n- {{Thing}}\n{{ThingThing}} is meant to {{Positive}} not {{Negative}}",
      },
    ],
  },
  {
    id: "question-engagement",
    label: "Question / Engagement",
    description: "A short framing line plus a list of questions that invite a reply.",
    structureHint: "Open with what you do/ask, list parallel questions, end with a prompt back to the reader.",
    examples: [
      {
        input:
          "I've started doing a weekly review and tracking it in Notion.\nI'm asking myself:\n- What went well?\n- Where did I get stuck?\n- When did I feel most energized?\nWhat are your review questions?",
        template:
          "I've started doing a {{Topic}} weekly review and tracking it:\nI'm asking myself:\n- {{Question}}\n- {{Question}}\n- {{Question}}\nHow do you review {{Topic}}",
      },
    ],
  },
  {
    id: "observation",
    label: "Observation",
    description: "A noticed pattern or insight stated plainly, then unpacked.",
    structureHint: "State the observation, give the evidence/why, land a takeaway.",
    examples: [
      {
        input:
          "I've noticed the best engineers write the worst code first.\nThey ship a rough version, see it fail, then fix what actually breaks.\nDone beats perfect.",
        template:
          "I've noticed {{Observation}}.\n{{Evidence}}\n{{Takeaway}}",
      },
    ],
  },
  {
    id: "story-pas",
    label: "Story (PAS)",
    description: "Problem → Agitate → Solution narrative.",
    structureHint:
      "Name the problem, agitate the cost/pain, then resolve with the solution and the result.",
    examples: [
      {
        input:
          "Two years ago I was drowning in support tickets.\nEvery night I'd fall asleep behind, wake up further behind.\nThen I built one automation. Now I close tickets in half the time.",
        template:
          "{{TimeAgo}} I was {{Problem}}.\n{{Agitation}}\nThen I {{Solution}}. Now {{Result}}.",
      },
    ],
  },
  {
    id: "how-to",
    label: "How-To",
    description: "A goal plus the steps to reach it (steps named, not numbered linearly).",
    structureHint:
      "State the outcome, then steps as imperative verb + object. Name steps descriptively, never 'step 4 / as above'.",
    examples: [
      {
        input:
          "Want to write a viral hook? Open a loop.\nMake a bold claim.\nPromise a payoff.\nThen deliver it fast.",
        template:
          "Want to {{Outcome}}? {{OpeningMove}}.\n{{Move}}.\n{{Move}}.\nThen {{Payoff}}.",
      },
    ],
  },
  {
    id: "hook-body-cta",
    label: "Hook / Body / CTA",
    description: "A scroll-stopping hook, a value body, and a single call to action.",
    structureHint: "One-line hook, a tight value body, one clear CTA (high-value active verb).",
    examples: [
      {
        input:
          "Most newsletters die at 100 subs.\nMine grew to 10k because I sent one email people actually forwarded.\nWant the template? Reply 'SEND'.",
        template:
          "{{Hook}}\n{{ValueBody}}\n{{CTA}}",
      },
    ],
  },
  {
    id: "quote-insight",
    label: "Quote / Insight",
    description: "A short, punchy aphorism or reframed insight.",
    structureHint: "Compress to one or two lines; a sharp reframe or contrast.",
    examples: [
      {
        input: "You don't need more time. You need fewer priorities.",
        template: "You don't need more {{Thing}}. You need fewer {{OtherThing}}.",
      },
    ],
  },
  {
    id: "case-study",
    label: "Case Study",
    description: "Before → after with specifics and numbers.",
    structureHint: "Subject + starting state → what changed → the measurable result.",
    examples: [
      {
        input:
          "A SaaS team was losing 40% of trials to manual onboarding.\nThey added one guided checklist.\nTrial-to-paid jumped to 22%.",
        template:
          "{{Subject}} was {{StartingState}}.\nThey {{Change}}.\n{{Metric}} jumped to {{Result}}.",
      },
    ],
  },
];

const FRAMEWORK_IDS = new Set(CONTENT_FRAMEWORKS.map((f) => f.id));
export const DEFAULT_FRAMEWORK = "observation";

export function isFramework(id: string): boolean {
  return FRAMEWORK_IDS.has(id);
}
export function frameworkLabel(id: string): string {
  return CONTENT_FRAMEWORKS.find((f) => f.id === id)?.label ?? id;
}
export function getFramework(id: string): ContentFramework | undefined {
  return CONTENT_FRAMEWORKS.find((f) => f.id === id);
}
