import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CANVAS_KIND_NAMES, type CanvasKindName } from "@/lib/canvas/names";
import { sourceFiles, stripComments } from "@/lib/ontology/storeScan";
import type { ResourcePurpose } from "@/lib/plans/resources";
import { DATA_SIGNAL_RULES } from "@/lib/types/dataSignal";
import { LOOPS, RULE_DECISIONS, UNMETERED_CALLS, type LoopKind } from "./registry";

/**
 * Where each kind in the learning registry (src/lib/loops/registry.ts) is made in the code, for
 * the Learning section of docs/ONTOLOGY.md (ADR-0017). A call site is a file, counted once per
 * kind: a meter call that names its purpose, a canvas's module, the file that holds a rule, or the
 * file that calls a model with no meter. Plain text scanning with Node built-ins, nothing run. Server and test only: it reads the disk.
 */

/** Files where a kind is made, repo relative and sorted. */
export type CallSites = Readonly<Record<LoopKind, readonly string[]>>;

/** The meter itself: its own calls pass a purpose through, so they are not call sites. */
export const METER_FILES: ReadonlySet<string> = new Set(["src/lib/plans/meter.ts"]);

/**
 * Meter calls whose purpose is worked out in code rather than written at the call. Each names the
 * purposes it can reach and any other file that picks one of them by name. A new call like this
 * fails src/lib/loops/callSites.test.ts until it is listed here with its reason.
 */
export const ROUTED_CALLS: Readonly<Record<string, { why: string; reaches: Partial<Record<ResourcePurpose, readonly string[]>> }>> = {
  "src/lib/content/create/generateNode.ts": {
    why: "writingPurposeOf picks the purpose from the node type, or blog_write when the CITABLE writer runs.",
    reaches: { blog_write: [], content_write: [], content_email: [], content_hub: [] },
  },
  "src/lib/content/blog/research.ts": {
    why: "The research brief spends under blog_research unless its caller names another searchPurpose, as the autopilot does.",
    reaches: { blog_research: [], autopilot_research: ["src/lib/autopilot/draftSteps.ts"] },
  },
  "src/lib/signals/collect.ts": {
    why: "A Google lookup spends under the purpose its asker names: get_from_google for a person, autopilot for the autopilot.",
    reaches: { get_from_google: [], autopilot: ["src/lib/autopilot/find.ts"] },
  },
  "src/lib/competitors/steps.ts": {
    why: "usageFor wraps the meter for the competitor steps, and each step names competitor_site or competitor_analysis.",
    reaches: { competitor_site: [], competitor_analysis: [] },
  },
};

/** Purposes spent outside src. The knowledge scraper worker writes its own spend to the meter document. */
export const OUTSIDE_SRC: Partial<Record<ResourcePurpose, readonly string[]>> = {
  product_map: ["workers/knowledge-scraper/src/productMap/usage.ts"],
};

/** Kinds made nowhere in the code, each with its reason. */
export const NO_CALL_SITE: Partial<Record<LoopKind, string>> = {
  other: "Kept so older months that spent under it keep a label; src/lib/agents/groundedMeter.test.ts fails on any new spend under it.",
};

/** The file that runs every connector rule. */
export const SIGNAL_RULES_FILE = "src/lib/connectors/signals/detect.ts";

/** A canvas's module: src/lib/canvas/kinds/ with its name in camel case (invite_wave is inviteWave.ts). */
export function canvasFileOf(name: CanvasKindName): string {
  return `src/lib/canvas/kinds/${name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}.ts`;
}

const CALL = /\b(aiUsage|usageMeter|usageFor)\(/g;
/** aiUsage(ctx, "p") and usageFor(ctx, "p"): the purpose is the second argument. */
const SECOND = /(?:aiUsage|usageFor)\(\s*[^,()]+,\s*["']([a-z_]+)["']/y;
/** usageMeter(ctx, "resource", "p"): the purpose is the third argument. */
const THIRD = /usageMeter\(\s*[^,()]+,\s*["'][a-z_]+["']\s*,\s*["']([a-z_]+)["']/y;

export interface MeterCalls {
  /** Purposes written at a call, each once, in the order found. */
  literal: string[];
  /** How many calls work their purpose out in code. */
  computed: number;
}

/** The meter calls in one file's text: comments are skipped, and so are the functions' own definitions. */
export function meterCallsIn(text: string): MeterCalls {
  const code = stripComments(text);
  const literal: string[] = [];
  let computed = 0;
  for (const m of code.matchAll(CALL)) {
    const at = m.index ?? 0;
    if (/\bfunction\s+$/.test(code.slice(Math.max(0, at - 20), at))) continue;
    const re = m[1] === "usageMeter" ? THIRD : SECOND;
    re.lastIndex = at;
    const found = re.exec(code);
    if (!found) computed++;
    else if (!literal.includes(found[1]!)) literal.push(found[1]!);
  }
  return { literal, computed };
}

export interface CallSiteScan {
  sites: CallSites;
  /** Files with a meter call that works its purpose out in code. */
  computedIn: string[];
  /** Literal purposes found at a call that the registry has no line for. */
  unknown: Array<{ file: string; purpose: string }>;
}

/** Every kind's call sites, from the source files' text. Pure: the caller reads the files. */
export function scanCallSites(files: ReadonlyArray<{ file: string; text: string }>): CallSiteScan {
  const found = new Map<string, Set<string>>(Object.keys(LOOPS).map((k) => [k, new Set<string>()]));
  const add = (kind: string, file: string) => found.get(kind)?.add(file);
  const computedIn: string[] = [];
  const unknown: Array<{ file: string; purpose: string }> = [];
  for (const { file, text } of files) {
    if (METER_FILES.has(file)) continue;
    const calls = meterCallsIn(text);
    for (const p of calls.literal) {
      if (found.has(p)) add(p, file);
      else unknown.push({ file, purpose: p });
    }
    if (calls.computed) computedIn.push(file);
  }
  for (const [file, { reaches }] of Object.entries(ROUTED_CALLS)) {
    for (const [p, pickers] of Object.entries(reaches)) for (const f of [file, ...(pickers ?? [])]) add(p, f);
  }
  for (const [p, outside] of Object.entries(OUTSIDE_SRC)) for (const f of outside ?? []) add(p, f);
  for (const name of CANVAS_KIND_NAMES) add(`canvas.${name}`, canvasFileOf(name));
  for (const rule of DATA_SIGNAL_RULES) add(rule, SIGNAL_RULES_FILE);
  for (const [key, r] of Object.entries(RULE_DECISIONS)) add(key, r.file);
  for (const [key, c] of Object.entries(UNMETERED_CALLS)) add(key, c.file);
  const sites = Object.fromEntries([...found].map(([k, set]) => [k, [...set].sort()])) as unknown as CallSites;
  return { sites, computedIn: computedIn.sort(), unknown };
}

/** The non-test source files under src, with their text. */
export function readSourceFiles(root: string = process.cwd()): Array<{ file: string; text: string }> {
  return sourceFiles("src", root).map((file) => ({ file, text: readFileSync(join(root, file), "utf8") }));
}

/** Every kind's call sites in this checkout, for npm run ontology:doc and its test. */
export function callSites(root: string = process.cwd()): CallSites {
  return scanCallSites(readSourceFiles(root)).sites;
}
