import { describe, it, expect } from "vitest";
import { renderEmailLayout, sanitizeEmailHtml, wrap, isSafeHref } from "./emailRender";
import { EmailLayoutSchema, type EmailLayout } from "@/lib/types/emailLayout";

describe("sanitizeEmailHtml", () => {
  it("strips scripts/handlers/js-hrefs but keeps safe markup + merge tokens", () => {
    const dirty =
      '<p onclick="x()">Hi {{first_name}}</p><script>evil()</script>' +
      '<a href="javascript:alert(1)">bad</a><a href="https://ok.com">good</a>' +
      "<img src=x onerror=alert(1)>";
    const clean = sanitizeEmailHtml(dirty);
    expect(clean).toContain("{{first_name}}"); // token survives verbatim
    expect(clean).not.toContain("<script");
    expect(clean).not.toContain("onclick");
    expect(clean).not.toMatch(/javascript:/i);
    expect(clean).toContain('href="https://ok.com"');
    expect(clean).not.toContain("onerror");
    expect(clean).not.toContain("<img"); // img not allowlisted inside text
  });

  it("keeps a text-align style but drops other styles", () => {
    const clean = sanitizeEmailHtml('<p style="text-align:center;color:red">hi</p>');
    expect(clean).toContain("text-align:center");
    expect(clean).not.toContain("color:red");
  });

  it("escapes stray angle brackets in text and neutralizes an unterminated tag", () => {
    expect(sanitizeEmailHtml("a < b and c > d")).toBe("a &lt; b and c &gt; d");
    const clean = sanitizeEmailHtml('<a href="/ok">ok</a> then <a href="/x" oops');
    expect(clean).toContain('href="/ok"'); // first complete anchor kept
    expect(clean).toContain("&lt;a"); // unterminated tag became escaped text, not live markup
  });
});

describe("isSafeHref", () => {
  it("allows http(s)/mailto/pure-token, rejects javascript:/data:", () => {
    expect(isSafeHref("https://x.com")).toBe(true);
    expect(isSafeHref("mailto:a@b.com")).toBe(true);
    expect(isSafeHref("{{hub_url}}")).toBe(true);
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("data:text/html,x")).toBe(false);
    expect(isSafeHref("")).toBe(false);
  });

  it("allows a plain root-relative path but rejects protocol-relative / backslash redirects", () => {
    expect(isSafeHref("/blog/post")).toBe(true);
    expect(isSafeHref("//evil.com")).toBe(false); // protocol-relative
    expect(isSafeHref("/\\evil.com")).toBe(false); // backslash → browser-normalized to //
  });
});

describe("renderEmailLayout", () => {
  const layout: EmailLayout = {
    blocks: [
      { id: "h1", kind: "heading", html: "Hello {{first_name}}", level: 2, align: "center" },
      { id: "t1", kind: "text", role: "copy", html: "<p>A <strong>bold</strong> word → {{hub_url}}</p>" },
      { id: "b1", kind: "button", label: "Go", href: "{{hub_url}}", align: "center", bg: "#111111", color: "#ffffff", radius: 8 },
      { id: "d1", kind: "divider", color: "#e5e5e5", thickness: 1 },
      { id: "s1", kind: "spacer", height: 24 },
    ],
  };

  it("renders email-safe table/inline HTML and preserves {{tokens}}", () => {
    const html = renderEmailLayout(layout);
    expect(html).toContain("Hello {{first_name}}");
    expect(html).toContain("{{hub_url}}");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<table"); // button + divider are table-based
    expect(html).toContain("text-align:center");
    expect(html).toContain("Go");
  });

  it("skips an image block with an empty src", () => {
    const html = renderEmailLayout({
      blocks: [{ id: "i", kind: "image", src: "", alt: "", href: null, width: 560, align: "center" }],
    });
    expect(html.trim()).toBe("");
  });

  it("applies the image block width (scalable) capped to the column", () => {
    const html = renderEmailLayout({
      blocks: [{ id: "i", kind: "image", src: "https://x.com/a.png", alt: "", href: null, width: 200, align: "center" }],
    });
    expect(html).toContain("width:200px");
    expect(html).toContain("max-width:100%");
  });

  it("applies per-section background + text colour (hex-guarded)", () => {
    const html = renderEmailLayout({
      blocks: [
        { id: "t", kind: "text", role: "copy", html: "<p>hi</p>", color: "#123456", sectionBg: "#eeeeee" },
        // A bad colour must NOT be interpolated (falls back).
        { id: "h", kind: "heading", html: "Bad", level: 2, align: "left", color: "red</style>" },
      ],
    });
    expect(html).toContain("background:#eeeeee");
    expect(html).toContain("color:#123456");
    expect(html).not.toContain("red</style>");
    expect(html).toContain("color:#111111"); // heading fell back to the default ink
  });

  it("renders the mandatory footer (sent-by brand + all three links) and social icons", () => {
    const html = renderEmailLayout({
      blocks: [
        { id: "s", kind: "social", align: "center", links: [{ platform: "linkedin", url: "https://x.com" }] },
        { id: "f", kind: "footer", text: "" },
      ],
    });
    // Fixed footer content — resolved downstream at send (mergeVars).
    expect(html).toContain("This email was sent by {{sender_brand}}.");
    expect(html).toContain("Manage preferences");
    expect(html).toContain("Unsubscribe");
    expect(html).toContain("Privacy Policy");
    expect(html).toContain("{{unsubscribe_url}}");
    expect(html).toContain("{{manage_preferences_url}}");
    expect(html).toContain("{{privacy_url}}");
    expect(html).toContain("data-vzb-footer"); // presence marker for the compiler safety net
    expect(html).toContain("data:image/svg+xml"); // greyscale favicon
  });

  it("neutralizes an unsafe button href to '#'", () => {
    const html = renderEmailLayout({
      blocks: [{ id: "b", kind: "button", label: "x", href: "javascript:alert(1)", align: "center", bg: "#111111", color: "#ffffff", radius: 8 }],
    });
    expect(html).not.toMatch(/javascript:/i);
    expect(html).toContain('href="#"');
  });
});

describe("wrap", () => {
  it("wraps inner HTML in the 560px card", () => {
    const out = wrap("<p>x</p>", null);
    expect(out).toContain("max-width:560px");
    expect(out).toContain("<p>x</p>");
    expect(out).toMatch(/^<!doctype html>/i);
  });

  it("drops a javascript: hero URL and escapes a quote-breakout attempt", () => {
    expect(wrap("x", "javascript:alert(1)")).not.toContain("<img");
    const out = wrap("x", 'https://ok.com/a"onerror=alert(1)');
    expect(out).toContain("&quot;onerror"); // quote escaped — no live onerror attribute
    expect(wrap("x", "https://ok.com/a.png")).toContain('src="https://ok.com/a.png"');
  });
});

describe("EmailLayoutSchema", () => {
  it("round-trips a full layout and rejects a bad hex colour", () => {
    const parsed = EmailLayoutSchema.parse({
      blocks: [{ id: "b", kind: "button", label: "Go", href: "", align: "center", bg: "#112233", color: "#ffffff", radius: 8 }],
    });
    expect(parsed.blocks[0]!.kind).toBe("button");
    expect(() =>
      EmailLayoutSchema.parse({ blocks: [{ id: "b", kind: "divider", color: "red", thickness: 1 }] }),
    ).toThrow();
  });
});
