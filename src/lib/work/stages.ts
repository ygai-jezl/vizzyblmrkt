import type { StageKey } from "@/lib/nav/growth";
import type { Place } from "@/lib/ontology/types";

/**
 * The ten stages of the Path, the whole journey of building a company, as Work names them (plan
 * decision 1): 1 Idea to 10 Improve. The ids stay in code; people read the labels. Each stage sits
 * on a place of the ontology (src/lib/ontology/types.ts PLACES) and, where Home's growth path has
 * one, on its stage (src/lib/nav/growth.ts). Stage is optional on a task, a column and a filter,
 * never a grouping.
 *
 * Pure: plain data and type imports only, so the list, the add page and measureKind.ts can use it
 * in the browser.
 */

export const COMPANY_STAGE_IDS = ["idea", "test", "set_up", "build", "market", "customers", "billing_tax", "support", "expand", "improve"] as const;
export type CompanyStage = (typeof COMPANY_STAGE_IDS)[number];

export interface CompanyStageInfo {
  id: CompanyStage;
  /** Its place on the Path, 1 to 10. */
  n: number;
  /** The plain word people read. */
  label: string;
  /** Where it sits in the ontology. */
  place: Place;
  /** Home's growth path stage it matches, or null where the growth path has none. */
  pathKey: StageKey | null;
}

export const COMPANY_STAGES: readonly CompanyStageInfo[] = [
  { id: "idea", n: 1, label: "Idea", place: "idea", pathKey: null },
  { id: "test", n: 2, label: "Test", place: "idea", pathKey: "launch" },
  { id: "set_up", n: 3, label: "Set up", place: "company", pathKey: "ready" },
  { id: "build", n: 4, label: "Build", place: "product", pathKey: "product" },
  { id: "market", n: 5, label: "Market", place: "content", pathKey: "grow" },
  { id: "customers", n: 6, label: "Customers", place: "customers", pathKey: "retain" },
  { id: "billing_tax", n: 7, label: "Billing and tax", place: "company", pathKey: null },
  { id: "support", n: 8, label: "Support", place: "support", pathKey: null },
  { id: "expand", n: 9, label: "Expand", place: "company", pathKey: null },
  { id: "improve", n: 10, label: "Improve", place: "signals", pathKey: null },
];

export function isCompanyStage(v: unknown): v is CompanyStage {
  return typeof v === "string" && (COMPANY_STAGE_IDS as readonly string[]).includes(v);
}

/** The stage with this id, or undefined. */
export function stageById(id: string): CompanyStageInfo | undefined {
  return COMPANY_STAGES.find((s) => s.id === id);
}

/** "5 Market", as the list and filters show a stage. */
export function stageLabel(id: CompanyStage): string {
  const s = stageById(id)!;
  return `${s.n} ${s.label}`;
}

/**
 * A stage from what a sheet or a person typed: its id, its label or its number, with or without
 * the number in front ("5 Market", "Market", "5", "billing and tax"), ignoring case. Null when it
 * names none.
 */
export function readStage(text: string): CompanyStage | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!t) return null;
  for (const s of COMPANY_STAGES) {
    const label = s.label.toLowerCase();
    if (t === s.id || t === label || t === String(s.n) || t === `${s.n} ${label}` || t === `${s.n}. ${label}` || t.replace(/ /g, "_") === s.id) return s.id;
  }
  return null;
}
