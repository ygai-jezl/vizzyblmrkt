import { describe, expect, it } from "vitest";
import { liveLine } from "./BlogAddress";

const live = { url: "https://acme.example/blog/a", at: "2026-11-24T22:07:54.974Z", by: "operator" as const, titleMatched: false };

describe("the live row", () => {
  it("says when it was seen or said, and with true dates the day it went up", () => {
    expect(liveLine(live)).toBe("Live · you said so 24 Nov 2026");
    expect(liveLine(live, { published: { at: "2026-11-20", source: "person" } })).toBe("Live · you said so 24 Nov 2026 · published 20 Nov 2026");
    expect(liveLine({ ...live, by: "check", found: "sitemap", textShare: 0.96, approvedOnLive: true }, { published: { at: "2026-11-19", source: "page" } })).toBe(
      "Live · found on your site 24 Nov 2026 · 96% of the text matches · published 19 Nov 2026 · approved",
    );
  });
});
