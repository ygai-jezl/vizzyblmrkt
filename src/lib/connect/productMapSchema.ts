import { z } from "zod";

/**
 * The PRODUCT MAP: what repo analysis learned about a customer's application,
 * as a proposal for their connection catalog and integration guide. ONE schema
 * shared by the analysis job (which writes it) and the app (which re-validates it
 * on read and turns accepted items into catalog entries) — so this file imports
 * only zod.
 *
 * Every item carries EVIDENCE: where in the code it came from, with an excerpt
 * the job has checked really is in that file. Items whose evidence couldn't be
 * verified are kept but flagged, and start unticked in review.
 */

export const PRODUCT_MAP_VERSION = 1;

const text = (max: number) => z.string().trim().max(max);

export const EvidenceSchema = z.object({
  path: text(300).min(1),
  line: z.number().int().positive().nullable().optional(),
  /** Copied verbatim from the file (after secret redaction), ≤ 240 chars. */
  excerpt: text(240).min(1),
  /** Set by the job: the excerpt was found in that file. */
  verified: z.boolean().default(false),
  /**
   * Set by the job from the path: source (code that runs), docs (docs, plans,
   * READMEs — intentions that may not be built) or test. Only source proves a
   * step, event, trait, fact or hook exists.
   */
  kind: z.enum(["source", "docs", "test"]).optional(),
  /**
   * Set by the job: the excerpt declares a type (an interface, type alias, class
   * or struct). A type names a shape, not a value — it doesn't prove a fact.
   */
  declaration: z.boolean().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const Confidence = z.enum(["high", "medium", "low"]);

const item = {
  confidence: Confidence.default("medium"),
  evidence: z.array(EvidenceSchema).max(5).default([]),
};

/** A kind of thing one person can have several of: `brand`, `workspace`, `project`. */
const KIND_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** Which of the entity kinds an item belongs to (done per brand, a value per brand); absent = the person. */
const entityKind = z.string().regex(KIND_RE).nullable().optional();

/**
 * Something one person can own or belong to several of — workspaces, brands,
 * projects, sites — which the product's onboarding and numbers are often about.
 */
export const MapEntityKindSchema = z.object({
  kind: z.string().regex(KIND_RE),
  /** Singular and plural, as the product says them: "brand" / "brands". */
  label: text(40).min(1),
  plural: text(40).min(1),
  /** The kind it sits inside, e.g. a brand's `workspace`. */
  parent: z.string().regex(KIND_RE).nullable().optional(),
  /** One person can own or belong to several (no one-per-user limit). */
  multiple: z.boolean().default(true),
  /** How people relate to it — owner, member, invited — and where that's stored. */
  membership: text(300).default(""),
  /** Any limit on how many, e.g. "brandsLimit on the plan". */
  limit: text(200).default(""),
  description: text(300).default(""),
  ...item,
});

export const MapStepSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  label: text(120).min(1),
  /** How the product decides it's done, in plain words. */
  completion: text(500).default(""),
  /** Route or deep link in the product, e.g. "/dashboard/audits". */
  path: text(300).nullable().optional(),
  /** server_event: there's a clear moment in server code; reconcile: derive it from stored state. */
  detection: z.enum(["server_event", "reconcile", "client_only"]).default("reconcile"),
  /** Done once per entity of this kind (e.g. per brand), not once per person. */
  entityKind,
  ...item,
});

export const MapEventSchema = z.object({
  name: z.string().max(80).regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/),
  label: text(120).default(""),
  description: text(500).default(""),
  /** Where it happens in their code, in words. */
  when: text(300).default(""),
  /** The entity kind it happens to (e.g. an audit runs on a brand). */
  entityKind,
  ...item,
});

export const MapTraitSchema = z.object({
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  type: z.enum(["string", "number", "boolean", "timestamp"]).default("string"),
  label: text(120).default(""),
  description: text(500).default(""),
  ...item,
});

export const MapFactSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  label: text(120).min(1),
  /** `date`: a stored moment (last active, trial ends) — proposed only when the app that asked takes date facts. */
  type: z.enum(["number", "string", "boolean", "date"]).default("number"),
  unit: text(20).nullable().optional(),
  description: text(500).default(""),
  /** Where the product keeps or computes it. */
  source: text(200).default(""),
  /**
   * When only some have it — it needs a feature, add-on, plan or setup step — who
   * does, e.g. "brands with a product catalogue". Empty: every account has it.
   */
  appliesWhen: text(200).default(""),
  /** A value per entity of this kind (e.g. per brand), not per person. */
  entityKind,
  ...item,
});

export const MapGlossarySchema = z.object({
  term: text(80).min(1),
  definition: text(500).default(""),
  ...item,
});

/** Things the customer's side of the integration must handle (feeds the guide, not the catalog). */
export const MapHookSchema = z.object({
  kind: z.enum(["signup", "deletion", "consent", "preferences", "exit_rule", "timezone", "other"]),
  description: text(500).min(1),
  ...item,
});

export const ProductMapSchema = z.object({
  version: z.literal(PRODUCT_MAP_VERSION).default(PRODUCT_MAP_VERSION),
  /** What the product is and how it's built, in a few sentences. */
  summary: text(1500).default(""),
  onboardingSteps: z.array(MapStepSchema).max(20).default([]),
  events: z.array(MapEventSchema).max(40).default([]),
  traits: z.array(MapTraitSchema).max(40).default([]),
  facts: z.array(MapFactSchema).max(30).default([]),
  glossary: z.array(MapGlossarySchema).max(40).default([]),
  hooks: z.array(MapHookSchema).max(30).default([]),
  entityKinds: z.array(MapEntityKindSchema).max(10).default([]),
  /** Gaps worth knowing, e.g. "timezone isn't stored at sign-up". */
  warnings: z.array(text(300)).max(20).default([]),
});
export type ProductMap = z.infer<typeof ProductMapSchema>;
export type MapStep = z.infer<typeof MapStepSchema>;
export type MapEvent = z.infer<typeof MapEventSchema>;
export type MapTrait = z.infer<typeof MapTraitSchema>;
export type MapFact = z.infer<typeof MapFactSchema>;
export type MapGlossary = z.infer<typeof MapGlossarySchema>;
export type MapHook = z.infer<typeof MapHookSchema>;
export type MapEntityKind = z.infer<typeof MapEntityKindSchema>;

/**
 * A step or fact id in the form the catalog needs (lower-case, underscores):
 * "createBrand", "add-brand" or "Add brand" → "create_brand" / "add_brand". A
 * leading digit gets the prefix ("1st_audit" → "step_1st_audit"). Empty when
 * nothing usable is left.
 */
export function toCatalogId(raw: unknown, prefix: string): string {
  if (typeof raw !== "string") return "";
  const s = raw
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!s) return "";
  return (/^[a-z]/.test(s) ? s : `${prefix}_${s}`).slice(0, 64).replace(/_+$/, "");
}

/**
 * Tidy one model-written item before validation: cap and trim its evidence, and
 * DROP any `verified` claim — only the job's verifier may set that. Step and fact
 * ids are ours to choose, so a badly formed one is fixed (or made from the label)
 * rather than losing the step; event names must match the product's, so aren't.
 */
function prepItem(x: unknown, section?: MapSection): unknown {
  if (!x || typeof x !== "object") return x;
  const o = { ...(x as Record<string, unknown>) };
  if (section === "onboardingSteps" || section === "facts") {
    const prefix = section === "facts" ? "fact" : "step";
    const id = toCatalogId(o.id, prefix) || toCatalogId(o.label, prefix);
    if (id) o.id = id;
  }
  // Entity kinds are ours to name too: "Brand" or "brandProfile" → "brand" / "brand_profile".
  const asKind = (v: unknown) => toCatalogId(v, "kind").slice(0, 40).replace(/_+$/, "");
  if (section === "entityKinds") {
    const kind = asKind(o.kind) || asKind(o.label);
    if (kind) o.kind = kind;
    if (typeof o.parent === "string") o.parent = asKind(o.parent) || null;
  } else if (typeof o.entityKind === "string") {
    o.entityKind = asKind(o.entityKind) || null;
  }
  if (Array.isArray(o.evidence)) {
    o.evidence = o.evidence.slice(0, 5).map((e) => {
      if (!e || typeof e !== "object") return e;
      const ev = { ...(e as Record<string, unknown>) };
      delete ev.verified;
      delete ev.kind;
      delete ev.declaration;
      if (typeof ev.excerpt === "string") ev.excerpt = ev.excerpt.trim().slice(0, 240);
      if (typeof ev.line === "string" && /^\d+$/.test(ev.line)) ev.line = Number(ev.line);
      return ev;
    });
  }
  return o;
}

export const MAP_SECTIONS = ["onboardingSteps", "events", "traits", "facts", "glossary", "hooks", "entityKinds"] as const;
export type MapSection = (typeof MAP_SECTIONS)[number];

const SECTION_SCHEMA: Record<MapSection, z.ZodType> = {
  onboardingSteps: MapStepSchema,
  events: MapEventSchema,
  traits: MapTraitSchema,
  facts: MapFactSchema,
  glossary: MapGlossarySchema,
  hooks: MapHookSchema,
  entityKinds: MapEntityKindSchema,
};

/**
 * Whether one piece of evidence proves an item is built: found in the file, in
 * code that runs (docs count for glossary terms only) and, for a fact, more than
 * a type's declaration — a fact needs where its value is stored or computed.
 * Maps written before `kind` existed trust `verified`.
 */
export function proves(e: Evidence, section: MapSection): boolean {
  if (!e.verified) return false;
  if (section === "facts" && e.declaration) return false;
  return !e.kind || e.kind === "source" || (section === "glossary" && e.kind === "docs");
}

/** Validate ONE model-written item for a section (evidence tidied, `verified` stripped). */
export function parseMapItem(section: MapSection, raw: unknown): { ok: true; item: unknown } | { ok: false; reason: string } {
  const r = SECTION_SCHEMA[section].safeParse(prepItem(raw, section));
  if (r.success) return { ok: true, item: r.data };
  const issue = r.error.issues[0];
  return { ok: false, reason: issue ? `${issue.path.join(".") || "(item)"}: ${issue.message}`.slice(0, 200) : "invalid" };
}

/**
 * Parse a model's map leniently: keep every item that validates, drop the rest
 * (reporting how many), rather than losing the whole map to one bad field.
 */
export function parseProductMapLenient(raw: unknown): { map: ProductMap; dropped: number } {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  let dropped = 0;
  const list = <T>(key: MapSection, schema: z.ZodType<T>, max: number): T[] => {
    const arr = Array.isArray(obj[key]) ? (obj[key] as unknown[]) : [];
    const out: T[] = [];
    for (const x of arr) {
      const r = schema.safeParse(prepItem(x, key));
      if (r.success && out.length < max) out.push(r.data);
      else dropped += 1;
    }
    return out;
  };
  const warnings = (Array.isArray(obj.warnings) ? obj.warnings : [])
    .filter((w): w is string => typeof w === "string")
    .map((w) => w.trim().slice(0, 300))
    .filter(Boolean)
    .slice(0, 20);
  const map = ProductMapSchema.parse({
    summary: typeof obj.summary === "string" ? obj.summary.slice(0, 1500) : "",
    onboardingSteps: list("onboardingSteps", MapStepSchema, 20),
    events: list("events", MapEventSchema, 40),
    traits: list("traits", MapTraitSchema, 40),
    facts: list("facts", MapFactSchema, 30),
    glossary: list("glossary", MapGlossarySchema, 40),
    hooks: list("hooks", MapHookSchema, 30),
    entityKinds: list("entityKinds", MapEntityKindSchema, 10),
    warnings,
  });
  return { map, dropped };
}
