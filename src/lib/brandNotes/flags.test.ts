import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isBlogEditorialEnabled } from "@/lib/content/blog/flags";
import { isBrandNotesChatEnabled, isBrandNotesEnabled } from "./flags";

afterEach(() => vi.unstubAllEnvs());

/** The value a variable is given in an apphosting file, or null when it isn't there. */
function valueIn(file: string, variable: string): string | null {
  const text = readFileSync(join(process.cwd(), file), "utf8");
  const m = new RegExp(`- variable: ${variable}\\n\\s+value: "([^"]*)"`).exec(text);
  return m ? m[1]! : null;
}

const SWITCHES = ["CREATE_BLOG_EDITORIAL_ENABLED", "BRAND_NOTES_ENABLED", "NEXT_PUBLIC_BRAND_NOTES_ENABLED", "BRAND_NOTES_CHAT_ENABLED"];

describe("the switches for editorial articles and What we've seen", () => {
  it("the editorial writer needs the CITABLE blog hub, and Vizzy's notes need the notes", () => {
    vi.stubEnv("CREATE_BLOG_EDITORIAL_ENABLED", "true");
    vi.stubEnv("BRAND_NOTES_CHAT_ENABLED", "true");
    expect([isBlogEditorialEnabled(), isBrandNotesChatEnabled()]).toEqual([false, false]);
    vi.stubEnv("CREATE_BLOG_CITABLE_ENABLED", "true");
    vi.stubEnv("BRAND_NOTES_ENABLED", "true");
    expect([isBlogEditorialEnabled(), isBrandNotesEnabled(), isBrandNotesChatEnabled()]).toEqual([true, true, true]);
  });

  it("are on in dev, and on in prod since the owner turned them on, each set there on purpose", () => {
    for (const v of SWITCHES) {
      expect(valueIn("apphosting.yaml", v), v).toBe("true");
      expect(valueIn("apphosting.prod.yaml", v), v).toBe("true");
    }
  });
});
