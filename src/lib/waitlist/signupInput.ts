import { z } from "zod";
import type { Campaign } from "@/lib/types/campaign";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const SignupAnswerInput = z.object({
  question_value: z.string().min(1),
  answer_value: z.string(),
});

/**
 * The public signup request body. `.strict()` rejects unknown fields so a
 * caller can't smuggle extra properties (e.g. score, status, tenantId) into the
 * write path — those are always set server-side.
 */
export const SignupInputSchema = z
  .object({
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    email: z.string().trim().max(320).regex(EMAIL_RE, "invalid email").optional(),
    phone: z.string().trim().min(3).max(40).optional(),
    answers: z.array(SignupAnswerInput).max(50).optional(),
    referredBySignupToken: z.string().trim().min(1).max(64).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    recaptchaToken: z.string().optional(),
    utm: z
      .object({
        source: z.string().trim().max(200).optional(),
        medium: z.string().trim().max(200).optional(),
        campaign: z.string().trim().max(200).optional(),
        content: z.string().trim().max(200).optional(),
        term: z.string().trim().max(200).optional(),
      })
      .optional(),
    referrerUrl: z.string().trim().max(2000).optional(),
    /** Visitor's resolved content language (BCP-47), re-validated server-side. */
    locale: z.string().trim().max(35).optional(),
  })
  .strict();

export type SignupInput = z.infer<typeof SignupInputSchema>;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate the parsed input against the CAMPAIGN's configuration: required
 * contact detail, name requirement, and that answers match the configured
 * questions (mandatory answered; dropdown answers within the option list; no
 * answers to unknown questions).
 */
export function validateSignupAgainstCampaign(
  campaign: Campaign,
  input: SignupInput,
): ValidationResult {
  const errors: string[] = [];

  // Contact detail
  const hasEmail = !!input.email;
  const hasPhone = !!input.phone;
  switch (campaign.requiredContactDetail) {
    case "EMAIL":
      if (!hasEmail) errors.push("email is required");
      break;
    case "PHONE":
      if (!hasPhone) errors.push("phone is required");
      break;
    case "BOTH":
      if (!hasEmail) errors.push("email is required");
      if (!hasPhone) errors.push("phone is required");
      break;
    case "EITHER":
      if (!hasEmail && !hasPhone) errors.push("email or phone is required");
      break;
  }

  // Name
  if (campaign.usesFirstnameLastname) {
    if (!input.firstName) errors.push("firstName is required");
    if (!input.lastName) errors.push("lastName is required");
  }

  // Answers vs configured questions
  const byQuestion = new Map(
    campaign.questions.map((q) => [q.question_value, q]),
  );
  const answered = new Set<string>();
  for (const a of input.answers ?? []) {
    const q = byQuestion.get(a.question_value);
    if (!q) {
      errors.push(`unknown question: ${a.question_value}`);
      continue;
    }
    answered.add(a.question_value);
    // Dropdown question (answer_value is an option list) — answer must be in it.
    if (q.answer_value && !q.answer_value.includes(a.answer_value)) {
      errors.push(`invalid option for: ${a.question_value}`);
    }
    if (!a.answer_value && !q.optional) {
      errors.push(`answer required for: ${a.question_value}`);
    }
  }
  for (const q of campaign.questions) {
    if (!q.optional && !answered.has(q.question_value)) {
      errors.push(`missing answer for: ${q.question_value}`);
    }
  }

  return { ok: errors.length === 0, errors };
}
