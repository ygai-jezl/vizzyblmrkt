import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CANVAS_KIND_NAMES } from "@/lib/canvas/names";
import { canvasFileOf, METER_FILES, readSourceFiles, ROUTED_CALLS } from "@/lib/loops/callSites";
import { LOOPS, UNMETERED_CALLS, type LoopKind } from "@/lib/loops/registry";
import { stripComments } from "@/lib/ontology/storeScan";
import { UNSTAMPED_REASONS, type UnstampedReason } from "@/lib/types/loopStamp";
import {
  generateBlockImage,
  generateEbookImage,
  generateGroundedJson,
  generateGroundedText,
  generateImage,
  generateImageWithDeadline,
  generateJsonWithSchema,
  generateSlideImage,
  generateText,
  generateTextStream,
  generateTextWithDeadline,
  generateTextWithFile,
  generateTextWithImage,
  readUrlsWithGoogle,
} from "./gemini";

/**
 * Every paid Gemini call is counted (USAGE_METER_ENABLED): only gemini.ts calls the models, and
 * none of its helpers can be called without the brand's usage. Web searches, images and tokens
 * all go through it.
 */

const SRC = join(process.cwd(), "src");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}
const matching = (re: RegExp) =>
  files(SRC)
    .filter((f) => re.test(readFileSync(f, "utf8")))
    .map((f) => f.slice(SRC.length + 1))
    .sort();

describe("Gemini use is always metered", () => {
  it("only gemini.ts asks Gemini to search Google", () => {
    expect(matching(/googleSearch\s*:/)).toEqual([join("lib", "agents", "gemini.ts")]);
  });

  it("only gemini.ts calls the models", () => {
    // embeddings.ts: knowledge search vectors (not counted, help says so). useLiveConversation.ts:
    // the waitlist's voice chat, which talks to Google directly with a short-lived token (not counted).
    // useVoiceCall.ts: Talk with Vizzy, the same way; the server counts its seconds as each call ends.
    expect(matching(/\.generateContent(Stream)?\(|new GoogleGenAI\(/)).toEqual(
      [
        join("lib", "agents", "embeddings.ts"),
        join("lib", "agents", "gemini.ts"),
        join("lib", "hooks", "useLiveConversation.ts"),
        join("lib", "onboarding", "voice", "useVoiceCall.ts"),
      ].sort(),
    );
  });

  it("every file that calls a Google model, through the SDK or over REST, is metered or has its line", () => {
    // gemini.ts meters each call it makes, and agentRuntime.ts is Vizzy's agent, counted as Vizzy
    // chat by the chat route. A model call with no meter that chooses something for a brand is in
    // UNMETERED_CALLS (src/lib/loops/registry.ts), so it has its line in LOOPS. Files that call a
    // model and choose nothing, each with its reason:
    const CHOOSES_NOTHING: Record<string, string> = {
      [join("lib", "agents", "embeddings.ts")]: "knowledge search vectors only turn text into numbers to find similar records (not counted, help says so)",
    };
    const sdk = /\.generateContent(Stream)?\(|new GoogleGenAI\(/;
    const rest = /aiplatform\.googleapis\.com|discoveryengine\.googleapis\.com|generativelanguage\.googleapis\.com/;
    // useVoiceCall.ts is Talk with Vizzy: the browser talks to Google with a short-lived token, and the
    // server meters each call's seconds under onboarding_voice as it ends (it has its line in LOOPS).
    const metered = [join("lib", "agents", "gemini.ts"), join("lib", "agents", "agentRuntime.ts"), join("lib", "onboarding", "voice", "useVoiceCall.ts")];
    const unmetered = Object.values(UNMETERED_CALLS).map((c) => join(...c.file.split("/").slice(1)));
    const callers = [...new Set([...matching(sdk), ...matching(rest)])].sort();
    expect(callers).toEqual([...new Set([...metered, ...unmetered, ...Object.keys(CHOOSES_NOTHING)])].sort());
    for (const why of Object.values(CHOOSES_NOTHING)) expect(why.length).toBeGreaterThan(30);
    // The scan finds a call over REST when there is one.
    expect(rest.test("`https://${location}-aiplatform.googleapis.com/v1beta1/projects/p`")).toBe(true);
    expect(rest.test("https://us-discoveryengine.googleapis.com/v1/projects/p/locations/us/rankingConfigs/c:rank")).toBe(true);
    expect(rest.test("https://www.googleapis.com/auth/cloud-platform")).toBe(false);
  });

  it('never spends under the purpose "other": every call names what it is for', () => {
    // src/lib/loops/registry.ts says other is no choice because nothing spends under it. Files
    // allowed to, each with its reason (none today; the list may only shrink).
    const ALLOWED_OTHER: Record<string, string> = {};
    const call = /\b(?:aiUsage|usageMeter|usageFor)\(\s*[^,()]+,\s*(?:["'][a-z_]+["']\s*,\s*)?["']other["']/;
    const named = /\b(?:purpose|searchPurpose)\s*[:=]\s*["']other["']|["']other["']\s+as\s+ResourcePurpose\b/;
    const spenders = [...new Set([...matching(call), ...matching(named)])].sort();
    expect(spenders).toEqual(Object.keys(ALLOWED_OTHER).sort());
    // The scan finds a call when there is one.
    expect(call.test('usage: aiUsage(ctx, "other"),')).toBe(true);
    expect(call.test('usageMeter(ctx, "google_lookups", "other")')).toBe(true);
    expect(call.test('aiUsage(ctx, "blog_write")')).toBe(false);
    expect(named.test('const p = { purpose: "other" };')).toBe(true);
  });

  it("the no-op usage is for tests only", () => {
    expect(matching(/\bNO_USAGE\b/)).toEqual([join("lib", "agents", "gemini.ts")]);
    expect(matching(/\bNO_METER\b/)).toEqual([]);
  });

  it("every helper needs the brand's usage", () => {
    // Type checks only: never called.
    const typed = () => {
      // @ts-expect-error a grounded call without usage doesn't compile
      void generateGroundedText("find", { timeoutMs: 1 });
      // @ts-expect-error a grounded call without usage doesn't compile
      void generateGroundedJson("find");
      // @ts-expect-error no usage
      void generateText("write");
      // @ts-expect-error no usage
      void generateText("write", {});
      // @ts-expect-error no usage
      void generateTextWithDeadline("write", { timeoutMs: 1 });
      // @ts-expect-error no usage
      void generateTextStream("write", {});
      // @ts-expect-error no usage
      void generateJsonWithSchema("write", { schema: {}, timeoutMs: 1 });
      // @ts-expect-error no usage
      void generateTextWithImage("read", "b64", "image/png");
      // @ts-expect-error no usage
      void generateTextWithFile("read", "b64", "application/pdf", {});
      // @ts-expect-error no usage
      void readUrlsWithGoogle("read", {});
      // @ts-expect-error no usage
      void generateImage("draw");
      // @ts-expect-error no usage
      void generateSlideImage("draw");
      // @ts-expect-error no usage
      void generateBlockImage("draw", "1:1", "m");
      // @ts-expect-error no usage
      void generateImageWithDeadline({ prompt: "draw", aspectRatio: "1:1", model: "m", timeoutMs: 1 });
      // @ts-expect-error no usage
      void generateEbookImage({ prompt: "draw" });
    };
    expect(typeof typed).toBe("function");
  });
});


/**
 * The stamp scan (learning loops step 5, 4.3 of the plan for steps 4 and 5): every file that calls
 * a model through the meter (aiUsage), and every POST, PUT or PATCH handler under src/app/api/agent
 * and src/app/api/v2, reads what was learned with learnedFor (src/lib/loops/read.ts) and a literal
 * kind, so what it makes is stamped and counted; or sits in UNRESOLVED, where its kind is worked
 * out in code or read in the file that saves what it made; or sits in UNSTAMPED, with a reason from
 * UNSTAMPED_REASONS. Plain text scanning of the source, comments left out.
 */

/** learnedFor(ctx, "kind", ...): the kind is the second argument. */
const READ_CALL = /\blearnedFor\(/g;
const READ_LITERAL = /learnedFor\(\s*[^,()]+,\s*["']([a-z0-9_.]+)["']/y;
const METER_CALL = /\baiUsage\(/g;
const WRITE_HANDLER = /export\s+(?:async\s+)?function\s+(?:POST|PUT|PATCH)\b|export\s+const\s+(?:POST|PUT|PATCH)\b|export\s*\{[^}]*\bas\s+(?:POST|PUT|PATCH)\b/;
const WRITE_ROUTES = /^src\/app\/api\/(?:agent|v2)\/(?:.+\/)?route\.ts$/;
/** A batch sender's RunCache read: `stamps.stamp(ctx, "kind")`. */
const RUN_CACHE_CALL = /\.stamps\.stamp\(\s*[^,()]+,\s*["']([a-z0-9_.]+)["']/g;

/** Calls to a function in code, leaving out its own definition. */
function callsIn(code: string, call: RegExp): number[] {
  return [...code.matchAll(call)].map((m) => m.index ?? 0).filter((at) => !/\bfunction\s+$/.test(code.slice(Math.max(0, at - 20), at)));
}

/** The kinds a file passes to learnedFor as literals, and how many calls work theirs out in code. */
function readsIn(code: string): { literal: string[]; computed: number } {
  const literal: string[] = [];
  let computed = 0;
  for (const at of callsIn(code, READ_CALL)) {
    READ_LITERAL.lastIndex = at;
    const m = READ_LITERAL.exec(code);
    if (!m) computed++;
    else if (!literal.includes(m[1]!)) literal.push(m[1]!);
  }
  return { literal, computed };
}

interface Scanned {
  file: string;
  /** It calls aiUsage. */
  meters: boolean;
  /** A POST, PUT or PATCH handler under src/app/api/agent or src/app/api/v2. */
  writes: boolean;
  reads: { literal: string[]; computed: number };
}

function scanStamps(sources: ReadonlyArray<{ file: string; text: string }>): Scanned[] {
  return sources.flatMap(({ file, text }) => {
    const code = stripComments(text);
    const meters = !METER_FILES.has(file) && callsIn(code, METER_CALL).length > 0;
    const writes = WRITE_ROUTES.test(file) && WRITE_HANDLER.test(code);
    const reads = readsIn(code);
    return meters || writes || reads.literal.length || reads.computed ? [{ file, meters, writes, reads }] : [];
  });
}

const isKind = (k: string): boolean => Object.prototype.hasOwnProperty.call(LOOPS, k);

type Reads = Partial<Record<LoopKind, readonly string[]>>;
interface Unresolved {
  why: string;
  /** Each kind the file makes and the files that read it with that kind as a literal; [] for the file itself, with a kind worked out in code. */
  reads: Reads;
}

const CANVAS_ROUTE = "src/app/api/agent/canvas/route.ts";
const FILL_PLAN = "src/lib/content/create/fillPlan.ts";
const GENERATE_NODE = "src/lib/content/create/generateNode.ts";
const BLOG_RESEARCH = "src/lib/content/blog/research.ts";
const HUB_ACTIONS = "src/lib/content/blog/hubActions.ts";
const REMAKE = "src/lib/loops/remake.ts";
const REFRESH_PROPOSE = "src/lib/content/blog/refreshPropose.ts";
const PLAN_ROUTES = "src/app/api/admin/workspace/[workspaceId]";

/** A ROUTED_CALLS line's purposes, each read in `readIn` ([] for the file itself): a purpose worked out in code is a kind worked out in code. */
function routed(file: string, readIn: readonly string[], extra: string): Unresolved {
  const line = ROUTED_CALLS[file]!;
  return { why: `${line.why} ${extra}`, reads: Object.fromEntries(Object.keys(line.reaches).map((p) => [p, readIn])) as Reads };
}

/**
 * Where the kind isn't a literal at a learnedFor call in the file itself (4.3): worked out in code,
 * or read in the file that saves what this one made. A purpose ROUTED_CALLS routes in code
 * (src/lib/loops/callSites.ts) reuses that line.
 */
const UNRESOLVED: Record<string, Unresolved> = {
  [CANVAS_ROUTE]: {
    why: "Stamps each canvas draft Vizzy saves as canvas.<its kind>, by: vizzy, before the kind's own save.",
    reads: Object.fromEntries(CANVAS_KIND_NAMES.map((n) => [`canvas.${n}`, []])) as Reads,
  },
  [canvasFileOf("journey")]: { why: "The launch journey canvas writes its copy; the canvas route stamps the draft it saves.", reads: { "canvas.journey": [CANVAS_ROUTE] } },
  [canvasFileOf("lifecycle")]: { why: "The product journey canvas lays out its draft; the canvas route stamps the draft it saves.", reads: { "canvas.lifecycle": [CANVAS_ROUTE] } },
  [canvasFileOf("invite_wave")]: { why: "The invite wave canvas writes the wave's copy; the canvas route stamps the wave it saves.", reads: { "canvas.invite_wave": [CANVAS_ROUTE] } },
  [FILL_PLAN]: routed(GENERATE_NODE, [], "fillPlanNode saves the words and reads under the purpose the writer used."),
  [GENERATE_NODE]: routed(GENERATE_NODE, [FILL_PLAN], "fillPlanNode, its one caller, saves the words and reads for them."),
  [BLOG_RESEARCH]: routed(BLOG_RESEARCH, [HUB_ACTIONS], "researchPlanBlog saves the brief and reads under the purpose it searched for."),
  [REMAKE]: {
    why: `${ROUTED_CALLS[REMAKE]!.why} Each image path reads its own kind; loop_learn makes nothing of its own, as the remade image is stamped under its kind.`,
    reads: Object.fromEntries(Object.entries(ROUTED_CALLS[REMAKE]!.reaches).filter(([p]) => p !== "loop_learn")) as Reads,
  },
  "src/lib/loops/runCache.ts": { why: "A batch sender's one read per brand and kind in a run, for the kinds the senders ask it for.", reads: { send_time: [] } },
  "src/lib/brandMap/research.ts": { why: "Brand map research proposes; runBrandMapResearch files the suggestions and reads for them.", reads: { brand_map_research: ["src/lib/brandMap/adminApi.ts"] } },
  "src/lib/content/blog/refreshReview.ts": { why: "The review's steps call the model; the copy a person applies is saved and read for in refreshPropose.ts.", reads: { blog_refresh: [REFRESH_PROPOSE] } },
  "src/lib/content/create/nodeBrief.ts": { why: "Writes a piece's brief; the brief route saves it on the node and reads for it.", reads: { content_brief: [`${PLAN_ROUTES}/content-plans/[planId]/nodes/[nodeId]/brief/route.ts`] } },
  "src/lib/content/create/suggestAngle.ts": { why: "Suggests an angle; the route hands it back with its stamp token and reads for it.", reads: { content_angle: [`${PLAN_ROUTES}/content-plans/suggest-angle/route.ts`] } },
  "src/lib/distribute/carousel/build.ts": { why: "Builds a carousel's slides; the carousel route saves them and reads for them.", reads: { carousel: [`${PLAN_ROUTES}/distribute/carousel/route.ts`] } },
  "src/app/api/agent/article-review/route.ts": { why: "Vizzy starts or moves on an article's review; the copy a person applies is saved and read for in refreshPropose.ts.", reads: { blog_refresh: [REFRESH_PROPOSE] } },
  "src/app/api/agent/brand-notes/route.ts": { why: "Vizzy files the notes it wrote as suggestions; agentSuggestNotes counts them as it files them.", reads: { brand_notes: ["src/lib/brandNotes/agentApi.ts"] } },
  "src/app/api/agent/business-profile/route.ts": { why: "Vizzy writes down a fact it heard for an admin to keep; agentSuggestFact counts it as it saves it.", reads: { onboarding: ["src/lib/onboarding/agentApi.ts"] } },
  "src/app/api/agent/work/route.ts": {
    why: "Vizzy suggests a Work task or drafts a Log note or decision; agentWorkPost stamps each under vizzy_chat and counts it as it saves it.",
    reads: { vizzy_chat: ["src/lib/work/agentApi.ts"] },
  },
};

/** Files that keep no stamp, each with its reason from UNSTAMPED_REASONS (4.3). */
const UNSTAMPED: Record<string, UnstampedReason> = {
  "src/app/api/admin/agent/chat/route.ts": "chat_reply",
  "src/lib/loops/learners/votes.ts": "learner",
  "src/lib/distribute/feedback/patterns.ts": "learner",
  "src/lib/content/create/styleProfile.ts": "learner",
  "src/app/api/agent/connectors/live/route.ts": "reads_only",
  "src/app/api/agent/connectors/numbers/route.ts": "reads_only",
  "src/app/api/agent/connectors/suggestions/route.ts": "reads_only",
  "src/app/api/agent/knowledge/route.ts": "reads_only",
  "src/app/api/agent/search/route.ts": "reads_only",
  "src/app/api/agent/lifecycle/connections/[connectionId]/learn/route.ts": "starts_worker",
  "src/app/api/v2/signups/route.ts": "connected_data",
  "src/app/api/v2/users/[userId]/events/route.ts": "connected_data",
  "src/app/api/v2/users/[userId]/route.ts": "connected_data",
  "src/app/api/v2/users/batch/route.ts": "connected_data",
};

describe("the stamp scan: every maker reads what was learned", () => {
  const sources = readSourceFiles();
  const scanned = scanStamps(sources);
  const byFile = new Map(scanned.map((s) => [s.file, s]));
  /** Whether a file reads this kind: as a literal, or worked out in code with its UNRESOLVED line naming the kind. */
  const readsKind = (file: string, kind: string) => {
    const s = byFile.get(file);
    if (!s) return false;
    if (s.reads.literal.includes(kind)) return true;
    const own = UNRESOLVED[file]?.reads[kind as LoopKind];
    return s.reads.computed > 0 && Array.isArray(own) && own.length === 0;
  };

  it("finds every maker and every write from Vizzy or a product reading with a literal kind, in UNRESOLVED, or in UNSTAMPED", () => {
    const problems = scanned
      .filter((s) => (s.meters || s.writes) && s.reads.literal.length === 0 && !(s.file in UNRESOLVED) && !(s.file in UNSTAMPED))
      .map((s) => `${s.file} (${s.meters ? "calls aiUsage" : "a POST, PUT or PATCH handler"}): call learnedFor(ctx, "<kind>") where what it makes is saved, or list it here with its reason`);
    expect(problems).toEqual([]);
  });

  it("reads only kinds the learning registry has", () => {
    const unknown = scanned.flatMap((s) => s.reads.literal.filter((k) => !isKind(k)).map((k) => `${s.file}: ${k}`));
    expect(unknown).toEqual([]);
  });

  it("lists each kind worked out in code, and each is read where its line says", () => {
    const computed = scanned.filter((s) => s.reads.computed > 0).map((s) => s.file).sort();
    const ownReaders = Object.entries(UNRESOLVED)
      .filter(([, u]) => Object.values(u.reads).some((files) => files?.length === 0))
      .map(([file]) => file)
      .sort();
    expect(computed, "a learnedFor call whose kind isn't a literal goes in UNRESOLVED, with [] for each kind it reaches").toEqual(ownReaders);
    const problems: string[] = [];
    for (const [file, u] of Object.entries(UNRESOLVED)) {
      expect(u.why.length, file).toBeGreaterThan(30);
      expect(Object.keys(u.reads).length, file).toBeGreaterThan(0);
      for (const [kind, readIn] of Object.entries(u.reads) as Array<[string, readonly string[]]>) {
        if (!isKind(kind)) problems.push(`${file}: ${kind} is not a kind in the learning registry`);
        for (const reader of readIn) if (!readsKind(reader, kind)) problems.push(`${file}: ${reader} does not read ${kind}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("names only files the scan finds, each in one place, with a reason from the closed list", () => {
    const stale: string[] = [];
    for (const file of Object.keys(UNRESOLVED)) {
      const s = byFile.get(file);
      if (!s || !(s.reads.computed > 0 || ((s.meters || s.writes) && s.reads.literal.length === 0))) stale.push(`UNRESOLVED ${file}`);
    }
    for (const [file, reason] of Object.entries(UNSTAMPED)) {
      const s = byFile.get(file);
      if (!s || !(s.meters || s.writes) || s.reads.literal.length > 0 || s.reads.computed > 0 || file in UNRESOLVED) stale.push(`UNSTAMPED ${file}`);
      if (!(UNSTAMPED_REASONS as readonly string[]).includes(reason)) stale.push(`UNSTAMPED ${file}: ${reason} is not in UNSTAMPED_REASONS`);
    }
    expect(stale).toEqual([]);
  });

  it("gives RunCache the kinds the batch senders ask it for", () => {
    const asked = new Set(sources.flatMap(({ text }) => [...stripComments(text).matchAll(RUN_CACHE_CALL)].map((m) => m[1]!)));
    expect([...asked].sort()).toEqual(Object.keys(UNRESOLVED["src/lib/loops/runCache.ts"]!.reads).sort());
  });

  it("would catch a new maker or handler that reads nothing (the scan still sees them)", () => {
    expect(readsIn('const { stamp } = await learnedFor(ctx, "post_image", { scope });')).toEqual({ literal: ["post_image"], computed: 0 });
    expect(readsIn('await learnedFor(\n    ctx,\n    "blog_hero",\n    { outputId },\n  );')).toEqual({ literal: ["blog_hero"], computed: 0 });
    expect(readsIn("await learnedFor(ctx, `canvas.${kind}`, { by: \"vizzy\" });")).toEqual({ literal: [], computed: 1 });
    expect(readsIn("export async function learnedFor(ctx: TenantContext, kind: LoopKind) {}")).toEqual({ literal: [], computed: 0 });
    const found = scanStamps([
      { file: "src/lib/content/quickPost.ts", text: 'const usage = aiUsage(ctx, "content_write");\n// learnedFor(ctx, "content_write") only in a comment\n' },
      { file: "src/app/api/agent/new-thing/route.ts", text: "export async function POST(req: Request) {}\n" },
      { file: "src/app/api/v2/things/route.ts", text: "const handler = async () => null;\nexport { handler as PUT };\n" },
      { file: "src/app/api/admin/things/route.ts", text: "export async function POST(req: Request) {}\n" },
    ]);
    expect(found.map((s) => [s.file, s.meters, s.writes, s.reads.literal.length])).toEqual([
      ["src/lib/content/quickPost.ts", true, false, 0],
      ["src/app/api/agent/new-thing/route.ts", false, true, 0],
      ["src/app/api/v2/things/route.ts", false, true, 0],
    ]);
  });
});
