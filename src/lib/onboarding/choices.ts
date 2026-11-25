import { PROFILE_CHOICES, PROFILE_KEYS, type ProfileAnswers, type ProfileKey } from "@/lib/types/businessProfile";

/**
 * The four questions Vizzy asks a new brand, with their answers' labels, and the kinds of other
 * things it hears. Client safe: the welcome, the questions, Learned and Settings share it, and so
 * do Vizzy's routes. The words are the owner-approved mockups'.
 */

export interface ProfileOption {
  key: string;
  label: string;
}

export interface ProfileQuestion {
  key: ProfileKey;
  /** As asked on the questions screen. */
  q: string;
  /** As a label beside an answer ("Who you are"). */
  short: string;
  options: ProfileOption[];
}

const LABELS: { [K in ProfileKey]: Record<(typeof PROFILE_CHOICES)[K][number], string> } = {
  who: { solo: "A solo founder", team: "A small team", agency: "An agency, for clients" },
  run: { app: "An app or software", shop: "A shop or products", service: "A service or local business" },
  stage: { idea: "Still an idea", launched: "Launched, finding first customers", established: "Established, ready to grow" },
  want: { waitlist: "Test demand and a waitlist", audience: "Grow an audience", customers: "Turn sign-ups into customers" },
};

const ASKED: Record<ProfileKey, { q: string; short: string }> = {
  who: { q: "Who are you?", short: "Who you are" },
  run: { q: "What do you run?", short: "What you run" },
  stage: { q: "Where is it today?", short: "Where it is today" },
  want: { q: "What do you want from YouGrow first?", short: "What you want first" },
};

/** The four questions in order, each with its three answers in order. */
export const QUESTIONS: ProfileQuestion[] = PROFILE_KEYS.map((key) => ({
  key,
  ...ASKED[key],
  options: (PROFILE_CHOICES[key] as readonly string[]).map((o) => ({ key: o, label: (LABELS[key] as Record<string, string>)[o]! })),
}));

/** The label of an answer ("A small team"), or "" for no answer or one that isn't a choice. */
export function answerLabel(key: ProfileKey, value: string | null | undefined): string {
  if (!value) return "";
  return (LABELS[key] as Record<string, string>)[value] ?? "";
}

/** The answers as label pairs, in question order, leaving out the unanswered ones. */
export function answeredLabels(answers: ProfileAnswers | undefined): Array<{ key: ProfileKey; short: string; label: string }> {
  return QUESTIONS.flatMap((q) => {
    const label = answerLabel(q.key, answers?.[q.key]);
    return label ? [{ key: q.key, short: q.short, label }] : [];
  });
}

/** What else Vizzy hears in a conversation, beyond the four answers. */
export const FACT_KINDS = ["timeline", "channel", "start", "constraint", "goal"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export const FACT_KIND_LABEL: Record<FactKind, string> = {
  timeline: "Timeline",
  channel: "Channel",
  start: "Starting point",
  constraint: "Constraint",
  goal: "Goal",
};
