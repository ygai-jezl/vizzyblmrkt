import raw from "./content.json";

/**
 * The public site's content: the six stages of the growth loop and the eleven
 * feature walkthroughs. English is the source text; other languages translate
 * it through ./i18n. Each walkthrough step's `scene` is a static HTML mock of
 * the product (made-up data, English only), animated on the client.
 */

export const STAGE_IDS = ["understand", "plan", "create", "launch", "engage", "learn"] as const;
export type StageId = (typeof STAGE_IDS)[number];

export const FEATURE_SLUGS = [
  "knowledge", "brand", "vizzy", "canvas", "ebook", "waitlists",
  "invites", "distribute", "journeys", "voice", "insights",
] as const;
export type FeatureSlug = (typeof FEATURE_SLUGS)[number];

export interface Stage {
  no: string;
  half: "Make" | "Grow";
  name: string;
  color: string;
  /** Where the stage sits on the loop, 0 to 1. */
  u: number;
  promise: string;
  body: string;
  reads: string[];
  writes: string[];
  who: string;
  decide: string;
  features: FeatureSlug[];
  live: string[];
  next: string[];
}

/** [seconds, pill label, pill tone, pipeline dots lit, show the named title]. */
export type StepHead = [number, string, string, number, boolean];

export interface FeatureStep {
  tab: string;
  title: string;
  desc: string;
  /** Length of the step's animation, in milliseconds. */
  dur: number;
  head: StepHead[];
  scene: string;
}

export interface Feature {
  name: string;
  color: string;
  aside: string;
  h1: [string, string];
  sub: string;
  obj: { id: string; via: string; named: string; placeholder: string };
  pipe: string[];
  close: [string, string];
  steps: FeatureStep[];
}

export const STAGES = raw.stages as unknown as Record<StageId, Stage>;
export const FEATURES = raw.features as unknown as Record<FeatureSlug, Feature>;
/** One line per feature, as it reads in the Features menu and on stage cards. */
export const FEATURE_TAGS = raw.tags as Record<FeatureSlug, string>;
/** The order the feature pages follow (Previous / Next). */
export const FEATURE_ORDER = raw.order as FeatureSlug[];

/** Each feature's address under /features/. */
export const FEATURE_PATH: Record<FeatureSlug, string> = {
  knowledge: "knowledge",
  brand: "brand-kit",
  vizzy: "vizzy",
  canvas: "content-canvas",
  ebook: "ebook-studio",
  waitlists: "waitlists",
  invites: "invite-waves",
  distribute: "distribute",
  journeys: "email-journeys",
  voice: "voice-chat",
  insights: "insights",
};

export function isStageId(x: string): x is StageId {
  return (STAGE_IDS as readonly string[]).includes(x);
}

/** The feature at an address under /features/, or null. */
export function featureByPath(path: string): FeatureSlug | null {
  return FEATURE_SLUGS.find((f) => FEATURE_PATH[f] === path) ?? null;
}

export function stageOf(feature: FeatureSlug): StageId {
  const id = STAGE_IDS.find((s) => STAGES[s].features.includes(feature));
  if (!id) throw new Error(`feature ${feature} is in no stage`);
  return id;
}

/** The stage `d` steps round the loop from `id` (wraps). */
export function nearStage(id: StageId, d: number): StageId {
  const n = STAGE_IDS.length;
  return STAGE_IDS[(STAGE_IDS.indexOf(id) + d + n) % n] as StageId;
}

/** The feature `d` steps along the feature order from `slug` (wraps). */
export function nearFeature(slug: FeatureSlug, d: number): FeatureSlug {
  const n = FEATURE_ORDER.length;
  return FEATURE_ORDER[(FEATURE_ORDER.indexOf(slug) + d + n) % n] as FeatureSlug;
}
