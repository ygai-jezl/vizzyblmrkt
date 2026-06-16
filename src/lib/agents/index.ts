/**
 * Email-hub AI agents.
 *  - Agent 3 (creative): performance-informed copy + Vertex Imagen hero images.
 *  - Agent 4 (compiler):  deterministic channel compilation + QA gate.
 * All prompts live in ./prompts/registry (no inline prompt literals).
 */
export {
  draftCopy,
  generateHeroImage,
  type CopyVariant,
  type DraftCopyInput,
  type DraftCopyResult,
  type GenerateHeroImageInput,
  type GenerateHeroImageResult,
} from "./creative";
export {
  compileBroadcast,
  compileJourneyEmail,
  type CompiledEmail,
} from "./compiler";
export { isGeminiConfigured } from "./gemini";
export {
  renderPrompt,
  getPrompt,
  listPrompts,
  type PromptTemplate,
} from "./prompts/registry";
