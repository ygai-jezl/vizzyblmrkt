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
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const Confidence = z.enum(["high", "medium", "low"]);

const item = {
  confidence: Confidence.default("medium"),
  evidence: z.array(EvidenceSchema).max(5).default([]),
};

export const MapStepSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  label: text(120).min(1),
  /** How the product decides it's done, in plain words. */
  completion: text(500).default(""),
  /** Route or deep link in the product, e.g. "/dashboard/audits". */
  path: text(300).nullable().optional(),
  /** server_event: there's a clear moment in server code; reconcile: derive it from stored state. */
  detection: z.enum(["server_event", "reconcile", "client_only"]).default("reconcile"),
  ...item,
});

export const MapEventSchema = z.object({
  name: z.string().max(80).regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/),
  label: text(120).default(""),
  description: text(500).default(""),
  /** Where it happens in their code, in words. */
  when: text(300).default(""),
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
  type: z.enum(["number", "string", "boolean"]).default("number"),
  unit: text(20).nullable().optional(),
  description: text(500).default(""),
  /** Where the product keeps or computes it. */
  source: text(200).default(""),
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

/**
 * Tidy one model-written item before validation: cap and trim its evidence, and
 * DROP any `verified` claim — only the job's verifier may set that.
 */
function prepItem(x: unknown): unknown {
  if (!x || typeof x !== "object") return x;
  const o = { ...(x as Record<string, unknown>) };
  if (Array.isArray(o.evidence)) {
    o.evidence = o.evidence.slice(0, 5).map((e) => {
      if (!e || typeof e !== "object") return e;
      const ev = { ...(e as Record<string, unknown>) };
      delete ev.verified;
      delete ev.kind;
      if (typeof ev.excerpt === "string") ev.excerpt = ev.excerpt.trim().slice(0, 240);
      if (typeof ev.line === "string" && /^\d+$/.test(ev.line)) ev.line = Number(ev.line);
      return ev;
    });
  }
  return o;
}

export const MAP_SECTIONS = ["onboardingSteps", "events", "traits", "facts", "glossary", "hooks"] as const;
export type MapSection = (typeof MAP_SECTIONS)[number];

const SECTION_SCHEMA: Record<MapSection, z.ZodType> = {
  onboardingSteps: MapStepSchema,
  events: MapEventSchema,
  traits: MapTraitSchema,
  facts: MapFactSchema,
  glossary: MapGlossarySchema,
  hooks: MapHookSchema,
};

/** Validate ONE model-written item for a section (evidence tidied, `verified` stripped). */
export function parseMapItem(section: MapSection, raw: unknown): { ok: true; item: unknown } | { ok: false; reason: string } {
  const r = SECTION_SCHEMA[section].safeParse(prepItem(raw));
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
  const list = <T>(key: string, schema: z.ZodType<T>, max: number): T[] => {
    const arr = Array.isArray(obj[key]) ? (obj[key] as unknown[]) : [];
    const out: T[] = [];
    for (const x of arr) {
      const r = schema.safeParse(prepItem(x));
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
    warnings,
  });
  return { map, dropped };
}
