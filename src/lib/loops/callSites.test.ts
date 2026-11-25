import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CANVAS_KIND_NAMES } from "@/lib/canvas/names";
import { DATA_SIGNAL_RULES } from "@/lib/types/dataSignal";
import { canvasFileOf, meterCallsIn, NO_CALL_SITE, OUTSIDE_SRC, readSourceFiles, ROUTED_CALLS, scanCallSites, SIGNAL_RULES_FILE } from "./callSites";
import { reasonProblems } from "./reason";
import { LOOPS, type LoopKind } from "./registry";

/**
 * The call sites behind the Learning section of docs/ONTOLOGY.md: every kind is made somewhere,
 * every listed file exists, and a meter call whose purpose is worked out in code is listed with
 * the purposes it reaches.
 */

const ROOT = process.cwd();
const scan = scanCallSites(readSourceFiles(ROOT));
const literalIn = (file: string, word: string) => readFileSync(join(ROOT, file), "utf8").includes(`"${word}"`);

describe("meterCallsIn", () => {
  it("finds the purpose written at a call, on one line or several", () => {
    expect(meterCallsIn('const u = aiUsage(ctx, "blog_hero", { tenant });')).toEqual({ literal: ["blog_hero"], computed: 0 });
    expect(meterCallsIn('usageMeter(ctx, "web_searches", "situations", { db }).check()')).toEqual({ literal: ["situations"], computed: 0 });
    expect(meterCallsIn('usageFor(ctx, "competitor_site", deps)')).toEqual({ literal: ["competitor_site"], computed: 0 });
    expect(meterCallsIn('aiUsage(\n  ctx,\n  "journeys",\n)')).toEqual({ literal: ["journeys"], computed: 0 });
    expect(meterCallsIn('aiUsage(ctx, "templates"); aiUsage(ctx, "templates");')).toEqual({ literal: ["templates"], computed: 0 });
  });

  it("counts a purpose worked out in code, and skips comments and the functions' own definitions", () => {
    expect(meterCallsIn("aiUsage(ctx, writingPurposeOf(node.type, citable))").computed).toBe(1);
    expect(meterCallsIn('aiUsage(ctx, input.searchPurpose ?? "blog_research")').computed).toBe(1);
    expect(meterCallsIn('usageMeter(ctx, "google_lookups", purpose, { db })').computed).toBe(1);
    expect(meterCallsIn('// aiUsage(ctx, "trending")\n/* usageMeter(ctx, "images", p) */')).toEqual({ literal: [], computed: 0 });
    expect(meterCallsIn("function usageFor(ctx: TenantContext, purpose: Purpose): AiUsage {}")).toEqual({ literal: [], computed: 0 });
  });
});

describe("the learning registry's call sites", () => {
  it("knows every purpose written at a meter call", () => {
    expect(scan.unknown).toEqual([]);
  });

  it("lists every meter call that works its purpose out in code, with the purposes it reaches", () => {
    expect(scan.computedIn, "add the file to ROUTED_CALLS in src/lib/loops/callSites.ts with its reason").toEqual(Object.keys(ROUTED_CALLS).sort());
    for (const [file, { why, reaches }] of Object.entries(ROUTED_CALLS)) {
      expect(reasonProblems(why), file).toEqual([]);
      expect(Object.keys(reaches).length, file).toBeGreaterThan(0);
      for (const [purpose, pickers] of Object.entries(reaches)) {
        expect(purpose in LOOPS, `${file} reaches ${purpose}`).toBe(true);
        for (const f of [file, ...(pickers ?? [])]) expect(literalIn(f, purpose), `${f} names "${purpose}"`).toBe(true);
      }
    }
  });

  it("finds the purposes spent outside src where the list says", () => {
    for (const [purpose, files] of Object.entries(OUTSIDE_SRC)) {
      for (const f of files ?? []) {
        expect(existsSync(join(ROOT, f)), f).toBe(true);
        expect(literalIn(f, purpose), `${f} names "${purpose}"`).toBe(true);
      }
    }
  });

  it("points every canvas at its module and every connector rule at the file that runs it", () => {
    for (const name of CANVAS_KIND_NAMES) {
      const file = canvasFileOf(name);
      expect(existsSync(join(ROOT, file)), file).toBe(true);
      expect(readFileSync(join(ROOT, file), "utf8"), file).toContain(`CanvasKind<"${name}">`);
    }
    expect(canvasFileOf("invite_wave")).toBe("src/lib/canvas/kinds/inviteWave.ts");
    for (const rule of DATA_SIGNAL_RULES) expect(literalIn(SIGNAL_RULES_FILE, rule), rule).toBe(true);
  });

  it("makes every kind somewhere, apart from the few named with a reason, in files that exist", () => {
    for (const kind of Object.keys(LOOPS) as LoopKind[]) {
      const files = scan.sites[kind];
      const why = NO_CALL_SITE[kind];
      if (why) {
        expect(files, `${kind} is made somewhere now: take it off NO_CALL_SITE`).toEqual([]);
        expect(why.length, kind).toBeGreaterThan(30);
      } else {
        expect(files.length, `${kind} has no call site: find it, or say why in NO_CALL_SITE`).toBeGreaterThan(0);
      }
      expect([...files].sort(), kind).toEqual(files);
      for (const f of files) expect(existsSync(join(ROOT, f)), `${kind}: ${f}`).toBe(true);
    }
  });
});
