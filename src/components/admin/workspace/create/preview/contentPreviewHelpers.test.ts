import { describe, it, expect } from "vitest";
import type { ContentNode } from "@/lib/types/contentPlan";
import {
  previewKind,
  frameWidth,
  backdropClass,
  toPlain,
  firstLine,
  metaSnippet,
  splitBlogTitle,
  handleFrom,
  domainFrom,
  initial,
  mockEngagement,
  formatCount,
  MOCK_LIKES_MIN,
  MOCK_LIKES_MAX,
  MOCK_COMMENT_RATIO,
  MOCK_REPOST_RATIO,
} from "./contentPreviewHelpers";

/** A minimal ContentNode for skin/derivation tests (only the read fields matter). */
function node(overrides: Partial<ContentNode>): ContentNode {
  return {
    id: "n1",
    type: "spoke",
    channel: "standalone",
    role: "Spoke",
    position: { x: 0, y: 0 },
    body: "",
    placeholderValues: {},
    status: "empty",
    subjectVariants: [],
    warnings: [],
    ...overrides,
  } as ContentNode;
}

describe("previewKind", () => {
  it("maps channels to their skin", () => {
    expect(previewKind(node({ channel: "linkedin" }))).toBe("linkedin");
    expect(previewKind(node({ channel: "x" }))).toBe("x");
    expect(previewKind(node({ channel: "instagram" }))).toBe("instagram");
    expect(previewKind(node({ channel: "blog" }))).toBe("blog");
    expect(previewKind(node({ channel: "newsletter" }))).toBe("email");
    expect(previewKind(node({ channel: "standalone" }))).toBe("generic");
    expect(previewKind(node({ channel: "totally-unknown" }))).toBe("generic");
  });

  it("email-sequence nodes are always the email skin, whatever the channel", () => {
    expect(previewKind(node({ type: "email", channel: "linkedin" }))).toBe("email");
    expect(previewKind(node({ type: "email", channel: "newsletter" }))).toBe("email");
  });
});

describe("frameWidth", () => {
  it("uses the native feed width per surface", () => {
    expect(frameWidth("linkedin", "feed")).toBe(555);
    expect(frameWidth("x", "feed")).toBe(598);
    expect(frameWidth("instagram", "feed")).toBe(468);
    expect(frameWidth("generic", "feed")).toBe(560);
  });

  it("blog and email widen when opened", () => {
    expect(frameWidth("blog", "opened")).toBeGreaterThan(frameWidth("blog", "feed"));
    // Email is an inbox row (wide) → a narrower reading column when opened.
    expect(frameWidth("email", "opened")).toBeLessThan(frameWidth("email", "feed"));
  });

  it("always returns a positive pixel width", () => {
    for (const k of ["linkedin", "x", "instagram", "blog", "email", "generic"] as const) {
      expect(frameWidth(k, "feed")).toBeGreaterThan(0);
      expect(frameWidth(k, "opened")).toBeGreaterThan(0);
    }
  });
});

describe("backdropClass", () => {
  it("returns a non-empty class for every skin", () => {
    for (const k of ["linkedin", "x", "instagram", "blog", "email", "generic"] as const) {
      expect(backdropClass(k).length).toBeGreaterThan(0);
    }
  });
});

describe("toPlain", () => {
  it("strips markdown markers and collapses whitespace", () => {
    expect(toPlain("## Heading\n\n**bold** and `code`")).toBe("Heading bold and code");
  });
  it("keeps link text, drops the URL", () => {
    expect(toPlain("Join at [our waitlist](https://vizzybl.ai/waitlist) now")).toBe(
      "Join at our waitlist now",
    );
  });
  it("is safe on empty / undefined", () => {
    expect(toPlain("")).toBe("");
    expect(toPlain(undefined as unknown as string)).toBe("");
  });
});

describe("firstLine", () => {
  it("returns the first non-empty line as plain text", () => {
    expect(firstLine("\n\n  # Hello world  \nsecond line")).toBe("Hello world");
  });
  it("is empty for blank input", () => {
    expect(firstLine("   \n  \n")).toBe("");
  });
});

describe("metaSnippet", () => {
  it("returns the whole thing when short", () => {
    expect(metaSnippet("A short summary.")).toBe("A short summary.");
  });
  it("truncates on a word boundary with an ellipsis", () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const snip = metaSnippet(long, 40);
    expect(snip.endsWith("…")).toBe(true);
    expect(snip.length).toBeLessThanOrEqual(41);
    // Every retained token is a whole word — nothing was severed mid-word.
    for (const tok of snip.slice(0, -1).trim().split(" ")) {
      expect(tok).toMatch(/^word\d+$/);
    }
  });
});

describe("splitBlogTitle", () => {
  it("uses a leading H1 as the title and removes it from the body", () => {
    const { title, body } = splitBlogTitle(node({ body: "# The Real Title\n\nbody text" }));
    expect(title).toBe("The Real Title");
    expect(body).toBe("body text");
  });

  it("promotes the first prose line to the title and drops it from the body", () => {
    const { title, body } = splitBlogTitle(node({ body: "Just a first line\nmore" }));
    expect(title).toBe("Just a first line");
    expect(body).toBe("more");
  });

  it("falls back to the role for an empty body", () => {
    expect(splitBlogTitle(node({ body: "", role: "Hub" }))).toEqual({ title: "Hub", body: "" });
  });

  // Regression: a mid-body heading must NOT become the title (it stays in the body),
  // so the opened article never renders the same heading twice.
  it("never duplicates the title inside the returned body", () => {
    const { title, body } = splitBlogTitle(
      node({ body: "An intro sentence with no heading.\n\n# Getting Started\n\nStep one…" }),
    );
    expect(title).toBe("An intro sentence with no heading.");
    expect(body).toContain("# Getting Started");
    expect(body).not.toContain(title);
  });

  it("keeps only the leading H1 as title when the body starts with one", () => {
    const { title, body } = splitBlogTitle(
      node({ body: "# The Ultimate Guide\n\nThis is the intro..." }),
    );
    expect(title).toBe("The Ultimate Guide");
    // The SERP snippet (metaSnippet(body)) must not repeat the title.
    expect(metaSnippet(body)).not.toContain("The Ultimate Guide");
  });
});

describe("mockEngagement", () => {
  it("keeps likes within [50, 280] and holds the comment/repost ratios", () => {
    // Sweep many distinct seeds to exercise the range + rounding.
    for (let i = 0; i < 500; i += 1) {
      const eng = mockEngagement(node({ id: `n-${i}` }));
      expect(eng.likes).toBeGreaterThanOrEqual(MOCK_LIKES_MIN);
      expect(eng.likes).toBeLessThanOrEqual(MOCK_LIKES_MAX);
      expect(eng.comments).toBe(Math.round(eng.likes * MOCK_COMMENT_RATIO));
      expect(eng.reposts).toBe(Math.round(eng.likes * MOCK_REPOST_RATIO));
      // Sanity on the ratios themselves.
      expect(MOCK_COMMENT_RATIO).toBe(0.16);
      expect(MOCK_REPOST_RATIO).toBe(0.03);
    }
  });

  it("is deterministic for a given node (stable across re-renders / view toggles)", () => {
    const n = node({ id: "stable-node" });
    expect(mockEngagement(n)).toEqual(mockEngagement(n));
  });

  it("varies across different nodes", () => {
    const seen = new Set(
      Array.from({ length: 40 }, (_, i) => mockEngagement(node({ id: `x-${i}` })).likes),
    );
    expect(seen.size).toBeGreaterThan(1);
  });

  it("falls back to role/channel when a node has no id", () => {
    const eng = mockEngagement(node({ id: "", role: "Spoke", channel: "x" }));
    expect(eng.likes).toBeGreaterThanOrEqual(MOCK_LIKES_MIN);
    expect(eng.likes).toBeLessThanOrEqual(MOCK_LIKES_MAX);
  });
});

describe("formatCount", () => {
  it("formats with thousands separators, fixed locale", () => {
    expect(formatCount(45)).toBe("45");
    expect(formatCount(1024)).toBe("1,024");
  });
});

describe("handleFrom / domainFrom / initial", () => {
  it("slugifies a display name into a handle", () => {
    expect(handleFrom("Your Brand!")).toBe("yourbrand");
    expect(handleFrom("Vizzybl AI")).toBe("vizzyblai");
  });
  it("falls back to a placeholder when empty", () => {
    expect(handleFrom("")).toBe("yourbrand");
    expect(handleFrom(null)).toBe("yourbrand");
    expect(domainFrom(undefined)).toBe("yourbrand.com");
  });
  it("derives an avatar monogram", () => {
    expect(initial("Vizzybl")).toBe("V");
    expect(initial("  acme")).toBe("A");
    expect(initial("")).toBe("Y");
  });
});
