import { ONTOLOGY } from "./registry";
import type { NumberDecision, OntologyType, PathDecision, PathTrigger, Place, SearchDecision, StoreDb, StoreRef } from "./types";
import { PLACES } from "./types";

/**
 * docs/ONTOLOGY.md, rendered from the registry (src/lib/ontology/registry.ts). Written by
 * `npm run ontology:doc` (scripts/ontology-doc.ts) and checked by doc.test.ts, so the file always
 * matches the registry. Registry order, no dates: the same registry gives the same file.
 * Repo paths go in code spans so npm run agents:check checks they exist.
 */

const PLACE_HEADINGS: Record<Place, { title: string; about: string }> = {
  idea: { title: "Idea", about: "Spine step 1. A hypothesis, its site and its waitlist." },
  signals: { title: "Signals", about: "Spine step 2. What happened, credited to an idea where there is one." },
  product: { title: "Product", about: "Spine step 3, and optional: the idea built and connected. Its users are identities of people." },
  customers: { title: "Customers", about: "Spine step 4. The people the brand grows with, and how it reaches them." },
  support: { title: "Support", about: "Spine step 5. Help after the sale." },
  content: { title: "Content", about: "A rail beside the spine: the brand's own writing and assets." },
  company: { title: "Company", about: "A rail beside the spine: the company itself, on the organisation." },
  partner_agent: { title: "Partners and agents", about: "A rail beside the spine: who acts for the brand." },
  platform: { title: "Platform", about: "A rail beside the spine: the brand record, members, queues, limits, audit, search and outside providers." },
};

const DB_LABEL: Record<StoreDb, string> = {
  control: "control plane Firestore",
  regional: "the brand's regional Firestore",
  search: "the brand's regional search database",
  gcs: "Cloud Storage",
  bigquery: "BigQuery",
  worm: "write once audit bucket",
  memory_bank: "Memory Bank",
  agent_sessions: "Agent Engine sessions",
  external: "an outside provider",
};

const TRIGGER_LABEL: Record<PathTrigger, string> = {
  person: "a person's erase or export",
  product_user: "a product user's erase or export",
  member: "the team member themselves",
  launch: "deleting a launch",
  retention: "retention",
  brand: "removing the record",
};

const HOME_LABEL: Record<OntologyType["home"], string> = {
  control: "the control plane",
  brand: "the brand's region",
  undecided: "undecided",
};

const PERSONAL_LABEL: Record<OntologyType["personal"], string> = {
  people: "yes, the brand's people",
  team: "the brand's own team",
  none: "no",
  undecided: "undecided",
};

const code = (s: string) => `\`${s}\``;

function storeLine(s: StoreRef): string {
  const where = s.path ? `${code(s.collection)} at ${code(s.path)}` : code(s.collection);
  const extras = [s.note, s.residencyGap ? `residency gap: ${s.residencyGap}` : undefined].filter(Boolean).join("; ");
  return `  - ${where}, ${DB_LABEL[s.db]}, in ${code(s.definedIn)}${extras ? `. ${capitalise(extras)}.` : ""}`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function pathLines(label: string, d: PathDecision): string[] {
  if ("none" in d) return [`- ${label}: none. ${capitalise(d.none)}.`];
  if ("gap" in d) return [`- ${label}: gap. ${capitalise(d.gap)}.`];
  return [
    `- ${label}:`,
    ...d.paths.map((p) => `  - ${code(p.fn)} in ${code(p.file)}, on ${TRIGGER_LABEL[p.trigger]}${p.when ? ` (${p.when})` : ""}`),
    ...(d.gaps ?? []).map((g) => `  - Gap: ${g}`),
  ];
}

function searchLine(d: SearchDecision): string {
  return "kinds" in d ? `- Search: ${d.kinds.map(code).join(", ")}` : `- Search: none. ${capitalise(d.none)}.`;
}

function numbersLine(d: NumberDecision): string {
  if ("meanings" in d) return `- Numbers: ${d.meanings.map(code).join(", ")}, through ${code(d.tool)}`;
  if ("none" in d) return `- Numbers: none. ${capitalise(d.none)}.`;
  return `- Numbers: gap. ${capitalise(d.gap)}.`;
}

function typeSection(t: OntologyType): string[] {
  const lines = [`### ${t.name} (${code(t.id)})`, "", t.description, ""];
  lines.push(`- Status: ${t.status === "built" ? "built" : `planned, in ${t.plannedIn}`}`);
  lines.push(`- Home: ${HOME_LABEL[t.home]}`);
  lines.push(`- Personal: ${PERSONAL_LABEL[t.personal]}`);
  if (t.stores.length) lines.push("- Stores:", ...t.stores.map(storeLine));
  if (t.links.length) lines.push(`- Links: ${t.links.map((l) => `${code(l.to)} through ${l.via}${l.many ? " (many)" : ""}`).join("; ")}`);
  if (t.events.length) lines.push(`- Events: ${t.events.map(code).join(", ")}`);
  if (t.states?.length) lines.push(`- States: ${t.states.map(code).join(", ")}`);
  if (t.personFields?.length) {
    lines.push(`- Person fields: ${t.personFields.map((f) => `${code(f.field)} ${f.stampedAtWrite ? "(written with the row)" : "(not written with the row yet)"}`).join(", ")}`);
  }
  lines.push(...pathLines("Erase", t.erase), ...pathLines("Export", t.export), searchLine(t.search), numbersLine(t.numbers), "");
  return lines;
}

/** Every gap the registry records, by type, in registry order. */
function gapsOf(t: OntologyType): string[] {
  const out: string[] = [];
  for (const [what, d] of [["erase", t.erase], ["export", t.export]] as const) {
    if ("gap" in d) out.push(`${what}: ${d.gap}`);
    if ("paths" in d) for (const g of d.gaps ?? []) out.push(`${what}: ${g}`);
  }
  if ("gap" in t.numbers) out.push(`numbers: ${t.numbers.gap}`);
  return out;
}

export function renderOntologyDoc(types: readonly OntologyType[] = ONTOLOGY): string {
  const built = types.filter((t) => t.status === "built").length;
  const lines: string[] = [
    "# The YouGrow ontology",
    "",
    "Generated from `src/lib/ontology/registry.ts`. Don't edit this file: change the registry, then run `npm run ontology:doc`.",
    "",
    "Every kind of thing YouGrow knows about, built or planned: where it is kept, whether it holds the brand's people, how it is erased and exported, how it is found, and how its numbers reach an agent. " +
      "The spine runs from an idea to its signals, an optional product, customers and support, with rails beside it. " +
      "A new collection or file store needs an entry in the registry: `src/lib/ontology/coverage.test.ts` fails until it has one.",
    "",
    `${types.length} types: ${built} built and ${types.length - built} planned.`,
    "",
    "On rows, `personId` means the `ct_` id of a person record (`src/lib/ontology/person.ts`). Events share one envelope (`src/lib/ontology/events.ts`).",
    "",
  ];
  for (const place of PLACES) {
    const here = types.filter((t) => t.place === place);
    if (!here.length) continue;
    const h = PLACE_HEADINGS[place];
    lines.push(`## ${h.title}`, "", h.about, "");
    for (const t of here) lines.push(...typeSection(t));
  }

  lines.push("## Gaps", "", "What the registry records as missing, by type. Each is a known gap, not a promise.", "");
  for (const t of types) {
    const gaps = gapsOf(t);
    if (!gaps.length) continue;
    lines.push(`- ${t.name} (${code(t.id)}):`, ...gaps.map((g) => `  - ${capitalise(g)}`));
  }
  lines.push("", "## Residency gaps", "", "Stores that don't keep to the brand's region.", "");
  for (const t of types) {
    for (const s of t.stores) {
      if (s.residencyGap) lines.push(`- ${t.name}: ${code(s.collection)} in ${code(s.definedIn)}. ${capitalise(s.residencyGap)}.`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
