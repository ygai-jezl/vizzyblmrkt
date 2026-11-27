import { afterEach, describe, expect, it, vi } from "vitest";
import { docToMarkdown } from "@/lib/developers/markdown";
import { HELP_BODIES } from "@/components/help/bodies";

// The approved examples paragraph says only what this deployment does: Found live is its own switch.
const page = () => docToMarkdown(HELP_BODIES["write-and-schedule"]!({}), "https://app.example.com");
const FOUND_LIVE = "A blog article found live on your site counts as approved too.";

/** Found live needs the brand map and its pages too (isBlogLiveWatchEnabled). */
const foundLive = (on: boolean) => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
  vi.stubEnv("BLOG_LIVE_WATCH_ENABLED", on ? "true" : "");
};

afterEach(() => vi.unstubAllEnvs());

describe("approved examples on Write and schedule", () => {
  it("says a blog article found live counts only while Found live is on", () => {
    vi.stubEnv("CONTENT_APPROVED_EXAMPLES_ENABLED", "true");
    foundLive(true);
    expect(page()).toContain(`without copying their words, facts or links. ${FOUND_LIVE} YouGrow keeps the newest 20 of each kind`);
    foundLive(false);
    expect(page()).toContain("without copying their words, facts or links. YouGrow keeps the newest 20 of each kind");
    expect(page()).not.toContain(FOUND_LIVE);
  });

  it("says a piece, its workflow or its programme takes its examples with it", () => {
    vi.stubEnv("CONTENT_APPROVED_EXAMPLES_ENABLED", "true");
    expect(page()).toContain("Deleting a piece, its workflow or its programme removes its examples.");
  });

  it("says nothing about examples with the switch off", () => {
    vi.stubEnv("CONTENT_APPROVED_EXAMPLES_ENABLED", "");
    foundLive(true);
    expect(page()).not.toContain("becomes an example of your own writing");
    expect(page()).not.toContain(FOUND_LIVE);
  });
});
