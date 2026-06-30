/**
 * Dynamic prompt composition — assemble a prompt from ordered, named sections in a
 * fixed canonical order (Identity → Communication → Temporal → UserProfile →
 * Constraints → Task), skipping any whose content is empty. Realizes the
 * variable-driven "dynamic system prompt" pattern (compose from DB variables at
 * call time rather than a static blob). Pure.
 */
export type PromptSectionName =
  | "identity"
  | "communication"
  | "temporal"
  | "userProfile"
  | "constraints"
  | "task";

const ORDER: PromptSectionName[] = [
  "identity",
  "communication",
  "temporal",
  "userProfile",
  "constraints",
  "task",
];

export function composePrompt(sections: Partial<Record<PromptSectionName, string>>): string {
  return ORDER.map((n) => sections[n]?.trim())
    .filter((s): s is string => Boolean(s))
    .join("\n\n");
}
