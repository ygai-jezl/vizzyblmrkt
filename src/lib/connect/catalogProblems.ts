import { ConnectionCatalogSchema, type ConnectionCatalog } from "@/lib/types/productConnection";

/**
 * What's wrong with a catalog before it's saved, per field and in plain words,
 * so the Catalog tab can mark the field itself rather than print a schema path.
 * Checks what the server checks (ConnectionCatalogSchema), plus ids used twice.
 */

type ListKey = "entityKinds" | "onboardingSteps" | "events" | "traits" | "facts" | "glossary";

/** `facts.6.label` → "Required." — keyed like the schema's issue paths. */
export type CatalogProblems = Record<string, string>;

export const fieldKey = (list: string, index: number, field: string) => `${list}.${index}.${field}`;

/** What the Catalog tab calls each field. */
const FIELD_LABELS: Record<ListKey, Record<string, string>> = {
  entityKinds: { kind: "Kind id", label: "What emails call one", plural: "What emails call several", parent: "Sits inside", description: "Description" },
  onboardingSteps: { id: "Step id", label: "Label", url: "Link", completion: "How it's done", kind: "Done per", order: "Order" },
  events: { name: "Event name", label: "Label", description: "What it means", kind: "Kind" },
  traits: { key: "Trait key", type: "Type", label: "Label", description: "Description" },
  facts: { id: "Fact id", label: "Label", type: "Type", unit: "Unit", source: "Where it comes from", appliesWhen: "Only for", description: "Description", kind: "Value per" },
  glossary: { term: "Term", definition: "Definition" },
};

export function fieldLabel(list: string, field: string): string {
  return FIELD_LABELS[list as ListKey]?.[field] ?? field;
}

/** The form an id must take, when it doesn't. */
const FORMATS: Record<string, string> = {
  "entityKinds.kind": "Use lower case letters, digits and _, starting with a letter — e.g. brand.",
  "entityKinds.parent": "Pick another kind, or none.",
  "onboardingSteps.id": "Use lower case letters, digits, _ or -, e.g. create_brand.",
  "onboardingSteps.kind": "Pick one of the kinds above, or Per person.",
  "events.name": "Use lower case words joined by dots, e.g. onboarding.step_completed.",
  "traits.key": "Start with a letter, then letters, digits, _ or - (no dots or spaces).",
  "facts.id": "Use lower case letters, digits and _, starting with a letter — e.g. share_of_voice.",
  "facts.kind": "Pick one of the kinds above, or Per person.",
};

/** The field every entry is known by — two entries can't share it. */
const ID_FIELDS: Record<ListKey, string> = {
  entityKinds: "kind",
  onboardingSteps: "id",
  events: "name",
  traits: "key",
  facts: "id",
  glossary: "term",
};
const NOUNS: Record<ListKey, string> = { entityKinds: "kind", onboardingSteps: "step", events: "event", traits: "trait", facts: "fact", glossary: "term" };

type Issue = { code: string; path: PropertyKey[]; minimum?: unknown; maximum?: unknown };

function explain(list: string, field: string, issue: Issue): string {
  switch (issue.code) {
    case "too_small":
      return Number(issue.minimum) <= 1 ? "Required." : `Use at least ${String(issue.minimum)} characters.`;
    case "too_big":
      return `Too long — up to ${String(issue.maximum)} characters.`;
    case "invalid_type":
      return "Required.";
    case "invalid_format":
      return FORMATS[`${list}.${field}`] ?? "Not in the right form.";
    case "invalid_value":
      return "Pick one of the options.";
    default:
      return "Not valid.";
  }
}

export function catalogProblems(catalog: ConnectionCatalog): CatalogProblems {
  const out: CatalogProblems = {};
  const parsed = ConnectionCatalogSchema.safeParse(catalog);
  if (!parsed.success) {
    for (const issue of parsed.error.issues as Issue[]) {
      const [list, index, field] = issue.path;
      if (typeof list !== "string") continue;
      if (typeof index !== "number" || typeof field !== "string") {
        // The list itself, e.g. too many facts.
        out[list] ??= issue.code === "too_big" ? `Too many ${NOUNS[list as ListKey] ?? "item"}s — up to ${String(issue.maximum)}.` : "Not valid.";
        continue;
      }
      out[fieldKey(list, index, field)] ??= explain(list, field, issue);
    }
  }
  for (const [list, field] of Object.entries(ID_FIELDS) as Array<[ListKey, string]>) {
    const seen = new Set<string>();
    ((catalog[list] ?? []) as Array<Record<string, unknown>>).forEach((e, i) => {
      const raw = typeof e[field] === "string" ? (e[field] as string).trim() : "";
      const id = list === "glossary" ? raw.toLowerCase() : raw;
      if (!id) return;
      if (seen.has(id)) out[fieldKey(list, i, field)] ??= `Another ${NOUNS[list]} already uses this.`;
      seen.add(id);
    });
  }
  return out;
}

/** "facts.6.label: …" from the server (a check the page didn't make) → that field's key, if it names one. */
export function serverProblemKey(detail: string | undefined): string | null {
  const m = /^catalog\.([A-Za-z]+)\.(\d+)\.([A-Za-z]+):/.exec(detail ?? "");
  return m ? fieldKey(m[1]!, Number(m[2]), m[3]!) : null;
}
