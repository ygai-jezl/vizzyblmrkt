import { composePrompt, brandVoiceSection, audienceSection } from "@/lib/agents/prompts/compose";
import { generateText, parseFirstJson } from "@/lib/agents/gemini";
import { spamScan, collapseBangs } from "@/lib/content/create/emailCritics";
import { WRITING_RULES } from "@/lib/content/writingRules";

/**
 * Write ONE email with the brand's voice — the copywriter shared by Create's
 * sequence nodes and lifecycle journeys. The caller supplies the TASK (which
 * prompt, which tokens are allowed); this composes it with the brand voice,
 * the house writing rules and the audience, calls the model once, parses the
 * JSON and runs the spam critic (with its safe "!!" auto-fix). Token baking,
 * readability and other channel rules stay with the caller.
 */

const MAX_BODY_CHARS = 20000;

export interface DraftedEmailCopy {
  subject: string;
  previewText: string;
  subjectVariants: string[];
  body: string;
  /** From the spam critic (e.g. "spam_phrase"). */
  warnings: string[];
}

/** Parse the email JSON (subject + preview + A/B variants + body); tolerant of extras. */
export function coerceDraftedEmail(raw: string | null): Omit<DraftedEmailCopy, "warnings"> {
  const empty = { subject: "", previewText: "", subjectVariants: [] as string[], body: "" };
  const j = raw ? parseFirstJson(raw) : null;
  if (!j || typeof j !== "object") return empty;
  const o = j as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const variants = Array.isArray(o.subjectVariants)
    ? (o.subjectVariants as unknown[])
        .map((v) => str(v, 200))
        .filter(Boolean)
        .slice(0, 3)
    : [];
  return {
    subject: str(o.subject, 200),
    previewText: str(o.previewText, 200),
    subjectVariants: variants,
    body: str(o.body, MAX_BODY_CHARS),
  };
}

/** Null when the model returned no usable body. */
export async function draftEmailCopy(input: {
  task: string;
  brandVoice?: string | null;
  audience?: string | null;
  generate?: (prompt: string) => Promise<string | null>;
}): Promise<DraftedEmailCopy | null> {
  const prompt = composePrompt({
    identity: brandVoiceSection(input.brandVoice),
    communication: WRITING_RULES,
    userProfile: audienceSection(input.audience),
    task: input.task,
  });
  const drafted = coerceDraftedEmail(await (input.generate ?? generateText)(prompt));
  if (!drafted.body) return null;
  // Critics run on the MODEL PROSE, before any caller bakes tokens in — so a baked
  // value containing "!!" (legal in a URL) is never mangled.
  const spam = spamScan(drafted.subject, drafted.body);
  return {
    subject: spam.cleanedSubject,
    previewText: collapseBangs(drafted.previewText),
    subjectVariants: drafted.subjectVariants.map((v) => collapseBangs(v)),
    body: spam.cleanedBody,
    warnings: [...spam.warnings],
  };
}
