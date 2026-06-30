/**
 * Modular block ROLES + module SIZES — the modular-componentization model. A
 * template is a typed block (its role) at a size; roles drive the Transformation
 * Matrix (a Data Point becomes an X Stat, etc.). Pure + client-safe.
 */
export interface BlockType {
  id: string;
  label: string;
  /** Default module size for this role. */
  defaultSize: "small" | "medium" | "large";
  description: string;
}

export const BLOCK_TYPES: BlockType[] = [
  { id: "hook", label: "Hook", defaultSize: "small", description: "A scroll-stopping opener that challenges or intrigues." },
  { id: "data-point", label: "Data Point", defaultSize: "small", description: "A verified metric or stat callout." },
  { id: "case-study", label: "Case Study", defaultSize: "large", description: "A before→after customer/example narrative." },
  { id: "cta", label: "CTA", defaultSize: "small", description: "A single call to action." },
  { id: "takeaway-list", label: "Takeaway List", defaultSize: "medium", description: "A parallel list of key points or benefits." },
  { id: "quote-testimonial", label: "Quote / Testimonial", defaultSize: "small", description: "A stylized quote or social proof." },
  { id: "step-process", label: "Step / Process", defaultSize: "medium", description: "A named, non-linear process or method." },
  { id: "comparison", label: "Comparison", defaultSize: "medium", description: "An options/tools/old-vs-new comparison." },
  { id: "full-post", label: "Full Post", defaultSize: "large", description: "A complete multi-block post or pillar." },
];

export interface ModuleSize {
  id: "small" | "medium" | "large";
  label: string;
  scope: string;
  purpose: string;
}

export const MODULE_SIZES: ModuleSize[] = [
  {
    id: "small",
    label: "Small (Concise)",
    scope: "Narrow scope, minimal detail.",
    purpose: "Relevance — grabs attention, high visual impact (titles, hooks, subject lines).",
  },
  {
    id: "medium",
    label: "Medium (Broad)",
    scope: "Broad scope, moderate detail.",
    purpose: "Interest — core benefits + context (takeaway lists, summaries, metric callouts).",
  },
  {
    id: "large",
    label: "Large (Deep)",
    scope: "Focused scope, high detail.",
    purpose: "Understanding — complex ideas (case narratives, process/methodology sections).",
  },
];

const BLOCK_IDS = new Set(BLOCK_TYPES.map((b) => b.id));
const SIZE_IDS = new Set(MODULE_SIZES.map((s) => s.id));
export const DEFAULT_BLOCK_TYPE = "full-post";

export function isBlockType(id: string): boolean {
  return BLOCK_IDS.has(id);
}
export function isModuleSize(id: string): id is ModuleSize["id"] {
  return SIZE_IDS.has(id as ModuleSize["id"]);
}
export function blockLabel(id: string): string {
  return BLOCK_TYPES.find((b) => b.id === id)?.label ?? id;
}
export function getBlockType(id: string): BlockType | undefined {
  return BLOCK_TYPES.find((b) => b.id === id);
}
export function moduleSizeLabel(id: string): string {
  return MODULE_SIZES.find((s) => s.id === id)?.label ?? id;
}
