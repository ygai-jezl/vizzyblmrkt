import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
