import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HELP_BODIES } from "@/components/help/bodies";
import { docToMarkdown } from "@/lib/developers/markdown";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";

/**
 * Launch and waitlist says what picking an email test winner does only while
 * WAITLIST_AB_WINNER_ENABLED is on (a server switch: /help and its Markdown copies read it).
 */

const ORIGIN = "https://app.example.com";
const SCREEN = readFileSync(join(process.cwd(), "src/components/admin/email/EmailAnalyticsSection.tsx"), "utf8");
const MESSAGE = "Another version already won this test. Reload the page to see it.";
const md = (ideaWords = false) => docToMarkdown(HELP_BODIES["launch-and-waitlist"]!({ ideaWords }), ORIGIN);

describe("the email test winner on Launch and waitlist", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("on: says how to pick, what a pick does, how to test again, and quotes the screen's message", () => {
    vi.stubEnv("WAITLIST_AB_WINNER_ENABLED", "true");
    const text = md();
    expect(text).toContain("## Pick the winning email");
    expect(text).toContain("press **Promote**");
    expect(text).toContain("everyone who reaches that email gets the winner");
    expect(text).toContain("People who already had the email keep the version they got.");
    expect(text).toContain("**A/B test this email**");
    expect(text).toContain("**Start a new test**");
    expect(text).toContain("Until you publish, the Analytics tab shows the earlier pick.");
    expect(text).toContain(MESSAGE);
    expect(SCREEN).toContain(`"${MESSAGE}"`);
    expect(text).not.toContain("Ask Vizzy how the emails did");
    for (const line of [...text.split("\n"), ...md(true).split("\n")]) {
      expect(dashesIn(line), line).toEqual([]);
      expect(aiTellsIn(line), line).toEqual([]);
    }
    expect(md(true)).toContain("Open your idea, then the **Analytics** tab.");
  });

  it("says Vizzy reads the winner only where Vizzy reads results", () => {
    vi.stubEnv("WAITLIST_AB_WINNER_ENABLED", "true");
    vi.stubEnv("RESULTS_CHAT_ENABLED", "true");
    expect(md()).toContain("Ask Vizzy how the emails did, and it says which version of each test won and when it was picked.");
  });

  it("off: says nothing about it", () => {
    const text = md();
    expect(text).not.toContain("Pick the winning email");
    expect(text).not.toContain(MESSAGE);
  });
});
