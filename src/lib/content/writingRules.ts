/**
 * Operational writing rules for MODULAR content — so generated blocks recombine
 * across channels without manual editing. Injected into the templatize/transform
 * prompts' "Communication" section (dynamic prompt composition). Pure constant.
 */
export const WRITING_RULES = `Modular writing rules (follow strictly so blocks recombine cleanly):
- Single-Concept: each block covers exactly ONE core idea — omit peripheral details or references to outside themes.
- Non-Linear: never use sequential/positional language ("in the next step", "as shown above", "in section four"). Refer to processes by descriptive NAMES, not numbers.
- Parallel Grammar — write each field in its prescribed pattern:
  · Headings -> a singular noun (e.g. "Integrations").
  · Action items / tasks -> an active verb (e.g. "Configure database").
  · List elements -> consistent noun phrases (e.g. "Scalable database", "Headless engine").
  · Conditional steps -> "If <condition>, <verb> <object>".
  · System feedback -> subject + verb + object (e.g. "The file uploaded successfully").
  · Step instructions -> imperative verb + object (e.g. "Upload the CSV file").
  · Calls-to-action -> a high-value active verb (e.g. "Download the report").
- Voice: avoid empty hyperbole ("revolutionize", "game-changing"); be concrete and specific.`;
