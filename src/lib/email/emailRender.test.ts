import { describe, it, expect } from "vitest";
import {
  renderEmailLayout,
  sanitizeEmailHtml,
  wrap,
  isSafeHref,
  renderHeaderBand,
  renderFooter,
  preheaderHtml,
  FOOTER_MARKER,
} from "./emailRender";
import { readableOn, type ResolvedEmailStyle } from "./emailStyle";
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

  // Pinned byte-for-byte: with no Email style saved, the shell must stay exactly this.
  it("pins today's output, with and without a hero", () => {
    expect(wrap("<p>x</p>", null)).toMatchInlineSnapshot(`
      "<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="margin:0;background:#f6f6f6">
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;background:#fff">
          
          <p>x</p>
        </div>
      </body></html>"
    `);
    expect(wrap("x", "https://ok.example.com/a.png")).toMatchInlineSnapshot(`
      "<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="margin:0;background:#f6f6f6">
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;background:#fff">
          <img src="https://ok.example.com/a.png" alt="" style="display:block;width:100%;max-width:560px;border-radius:12px;margin:0 0 20px"/>
          x
        </div>
      </body></html>"
    `);
  });
});

describe("wrap with an Email style", () => {
  const LOGO_URL = "https://app.example.com/api/brand-logo/tenant-1/11111111-2222-4333-8444-555555555555.png";
  const style = (over: Partial<ResolvedEmailStyle> = {}): ResolvedEmailStyle => ({
    logo: { url: LOGO_URL, width: 120, height: 40 },
    name: "Acme Co",
    altName: "Acme Co",
    headerColor: "#123456",
    accentColor: "#ff6600",
    ...over,
  });
  const imgTag = (html: string) => html.match(/<img\b[^>]*>/)?.[0] ?? "";

  it("changes nothing without a style, and a preheader still leads the card", () => {
    expect(wrap("<p>x</p>", null, {})).toBe(wrap("<p>x</p>", null));
    expect(wrap("<p>x</p>", null, { style: null })).toBe(wrap("<p>x</p>", null));
    expect(wrap("<p>x</p>", null, { preheader: "Soon" })).toBe(wrap(preheaderHtml("Soon") + "<p>x</p>", null));
    expect(wrap("<p>x</p>", null)).not.toContain("color-scheme");
  });

  it("draws a full-width band with bgcolor on the table and the cell, above the card", () => {
    const out = wrap("<p>x</p>", null, { style: style() });
    const band = renderHeaderBand(style());
    expect(band).toContain('width="100%"');
    expect(band).toContain("max-width:608px");
    expect(band.match(/bgcolor="#123456"/g)).toHaveLength(2);
    expect(band).toContain('<!--[if mso]><table role="presentation" width="608"');
    expect(out).toContain('<meta name="color-scheme" content="light only">');
    expect(out).toContain('<meta name="supported-color-schemes" content="light only">');
    expect(out.indexOf(band)).toBeGreaterThan(-1);
    expect(out.indexOf(band)).toBeLessThan(out.indexOf("max-width:560px"));
    // The logo: sized for Outlook, no link; alt is empty because the name sits beside it.
    const img = imgTag(band);
    expect(img).toContain(`src="${LOGO_URL}"`);
    expect(img).toContain('width="120"');
    expect(img).toContain('height="40"');
    expect(img).toContain('alt=""');
    expect(band).not.toContain("<a ");
  });

  it("shows the logo and the name when both are set", () => {
    const band = renderHeaderBand(style());
    expect(band).toContain("<img");
    expect(band).toContain(">Acme Co</span>");
  });

  it("shows the logo alone when there's no company name", () => {
    const band = renderHeaderBand(style({ name: null, altName: "Example Workspace" }));
    expect(imgTag(band)).toContain('alt="Example Workspace"');
    expect(band).not.toContain("<span");
  });

  it("shows only the name, in the readable colour, when there's no logo", () => {
    const dark = renderHeaderBand(style({ logo: null, name: null, altName: "Example Workspace" }));
    expect(dark).not.toContain("<img");
    expect(dark).toContain(">Example Workspace</span>");
    expect(dark).toContain(`color:${readableOn("#123456")}`);
    expect(readableOn("#123456")).toBe("#ffffff");
    const light = renderHeaderBand(style({ logo: null, headerColor: "#ffd400" }));
    expect(light).toContain("color:#000000");
  });

  it("escapes the name, including Mailchimp's *|TAG|* pipes", () => {
    const band = renderHeaderBand(style({ name: "<script>alert(1)</script> *|UNSUB|*", altName: "x" }));
    expect(band).not.toContain("<script>");
    expect(band).toContain("&lt;script&gt;");
    expect(band).toContain("*&#124;UNSUB&#124;*");
    expect(band).not.toContain("*|");
    const alt = renderHeaderBand(style({ name: null, altName: 'Acme" onerror="x *|FNAME|*' }));
    expect(imgTag(alt)).toContain('alt="Acme&quot; onerror=&quot;x *&#124;FNAME&#124;*"');
  });

  it("falls back to the name when the logo URL or size is wrong — never a broken image", () => {
    for (const logo of [
      { url: LOGO_URL.replace("https:", "http:"), width: 120, height: 40 },
      { url: "https://app.example.com/logo.png", width: 120, height: 40 },
      { url: LOGO_URL.replace(".png", ".webp"), width: 120, height: 40 },
      { url: `${LOGO_URL}?v=2`, width: 120, height: 40 },
      { url: LOGO_URL, width: 120.5, height: 40 },
      { url: LOGO_URL, width: 120, height: 400 },
    ]) {
      const band = renderHeaderBand(style({ logo }));
      expect(band).not.toContain("<img");
      expect(band).toContain(">Acme Co</span>");
    }
  });

  it("skips the band when the body already shows a brand logo", () => {
    const inner = `<p><img src="${LOGO_URL}" alt=""></p>`;
    const out = wrap(inner, null, { style: style() });
    expect(out).not.toContain('bgcolor="#123456"');
    expect(out.match(/\/api\/brand-logo\//g)).toHaveLength(1);
    expect(out).toContain("color-scheme"); // still a styled email
    expect(out).not.toContain("display:none"); // no band, so no derived preheader
  });

  it("puts the preheader before the band", () => {
    const out = wrap("<p>x</p>", null, { style: style(), preheader: "Your week in brief" });
    const pre = out.indexOf("Your week in brief");
    expect(pre).toBeGreaterThan(-1);
    expect(pre).toBeLessThan(out.indexOf("<!--[if mso]>"));
    expect(out.indexOf("<!--[if mso]>")).toBeLessThan(out.indexOf("max-width:560px"));
    expect(out.match(/Your week in brief/g)).toHaveLength(1);
    expect(out.match(/display:none/g)).toHaveLength(1);
  });

  it("with no preheader, leads with the card's opening words, so the name isn't the inbox snippet", () => {
    const hidden = (html: string) => html.match(/<div style="display:none;[^"]*">([^<]*)<\/div>/)?.[1];
    const inner =
      '<style>p{color:red}</style><!--[if mso]>x<![endif]--><h2>This week</h2>\n<p>Hi *|FNAME|*, here&rsquo;s <a href="https://example.com/x">what&#39;s new</a>.</p>';
    const out = wrap(inner, null, { style: style({ logo: null }) });
    expect(hidden(out)).toBe("This week Hi *|FNAME|*, here&rsquo;s what&#39;s new.");
    expect(out.indexOf("display:none")).toBeLessThan(out.indexOf("<!--[if mso]><table"));
    // Cut to length, never mid-entity; nothing to say, no preheader.
    expect(hidden(wrap(`<p>${"a".repeat(146)} &amp; more</p>`, null, { style: style() }))).toBe("a".repeat(146));
    expect(wrap(`<p><img src="https://cdn.example.com/a.png" alt=""></p>`, null, { style: style() })).not.toContain("display:none");
  });

  it("never adds a footer marker, so the body keeps exactly one footer", () => {
    for (const s of [style(), style({ logo: null }), style({ name: null })]) {
      expect(renderHeaderBand(s)).not.toContain(FOOTER_MARKER);
    }
    const out = wrap(`<p>x</p>${renderFooter(null)}`, null, { style: style() });
    expect(out.match(new RegExp(FOOTER_MARKER, "g"))).toHaveLength(1);
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
