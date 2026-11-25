import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UNMETERED_CALLS } from "@/lib/loops/registry";
import {
  generateBlockImage,
  generateEbookImage,
  generateGroundedJson,
  generateGroundedText,
  generateImage,
  generateImageWithDeadline,
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
    // the browser's voice chat, which talks to Google directly with a short-lived token (not counted).
    expect(matching(/\.generateContent(Stream)?\(|new GoogleGenAI\(/)).toEqual(
      [join("lib", "agents", "embeddings.ts"), join("lib", "agents", "gemini.ts"), join("lib", "hooks", "useLiveConversation.ts")].sort(),
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
    const metered = [join("lib", "agents", "gemini.ts"), join("lib", "agents", "agentRuntime.ts")];
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
