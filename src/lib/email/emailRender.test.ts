import { describe, it, expect } from "vitest";
import {
  renderEmailLayout,
  sanitizeEmailHtml,
  wrap,
  isSafeHref,
  renderHeaderBand,
  renderFooter,
  preheaderHtml,
  wrapLetter,
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

  // Pinned byte-for-byte: a solid header with automatic text colour must keep drawing exactly this.
  it("pins today's band: logo and name on a dark header, the logo alone, the name alone on yellow", () => {
    expect(renderHeaderBand(style())).toMatchInlineSnapshot(`"<!--[if mso]><table role="presentation" width="608" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]--><table role="presentation" width="100%" align="center" cellpadding="0" cellspacing="0" bgcolor="#123456" style="width:100%;max-width:608px;margin:0 auto;background-color:#123456"><tr><td bgcolor="#123456" align="left" style="padding:16px 24px;background-color:#123456"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="vertical-align:middle"><img src="https://app.example.com/api/brand-logo/tenant-1/11111111-2222-4333-8444-555555555555.png" width="120" height="40" alt="" style="display:block;width:120px;height:40px;border:0;outline:none;text-decoration:none;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#ffffff" /></td><td style="vertical-align:middle;padding-left:12px"><span style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#ffffff">Acme Co</span></td></tr></table></td></tr></table><!--[if mso]></td></tr></table><![endif]-->"`);
    expect(renderHeaderBand(style({ name: null, altName: "Example Workspace" }))).toMatchInlineSnapshot(`"<!--[if mso]><table role="presentation" width="608" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]--><table role="presentation" width="100%" align="center" cellpadding="0" cellspacing="0" bgcolor="#123456" style="width:100%;max-width:608px;margin:0 auto;background-color:#123456"><tr><td bgcolor="#123456" align="left" style="padding:16px 24px;background-color:#123456"><img src="https://app.example.com/api/brand-logo/tenant-1/11111111-2222-4333-8444-555555555555.png" width="120" height="40" alt="Example Workspace" style="display:block;width:120px;height:40px;border:0;outline:none;text-decoration:none;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#ffffff" /></td></tr></table><!--[if mso]></td></tr></table><![endif]-->"`);
    expect(renderHeaderBand(style({ logo: null, headerColor: "#ffd400" }))).toMatchInlineSnapshot(`"<!--[if mso]><table role="presentation" width="608" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]--><table role="presentation" width="100%" align="center" cellpadding="0" cellspacing="0" bgcolor="#ffd400" style="width:100%;max-width:608px;margin:0 auto;background-color:#ffd400"><tr><td bgcolor="#ffd400" align="left" style="padding:16px 24px;background-color:#ffd400"><span style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#000000">Acme Co</span></td></tr></table><!--[if mso]></td></tr></table><![endif]-->"`);
  });

  describe("header options", () => {
    const cell = (band: string) => band.match(/<td bgcolor="[^"]*" align="left" style="([^"]*)">/)?.[1];

    it("a gradient paints only the cell, over colour 1 — which stays bgcolor and background-color everywhere", () => {
      const band = renderHeaderBand(style({ headerColor: "#7c3aed", headerGradientColor: "#4f46e5" }));
      expect(band.match(/bgcolor="#7c3aed"/g)).toHaveLength(2);
      expect(band).toContain('max-width:608px;margin:0 auto;background-color:#7c3aed"');
      expect(cell(band)).toBe(
        "padding:16px 24px;background-color:#7c3aed;background-image:linear-gradient(135deg,#7c3aed,#4f46e5)",
      );
      expect(band.match(/linear-gradient/g)).toHaveLength(1);
      expect(band).not.toMatch(/v:|vml/i);
      expect(band).toContain('<!--[if mso]><table role="presentation" width="608"');
    });

    it("a forced white or black reaches the name span and the logo's alt text", () => {
      const white = renderHeaderBand(style({ logo: null, headerColor: "#ffd400", headerText: "white" }));
      expect(white).toContain('font-weight:700;color:#ffffff">Acme Co</span>');
      const black = renderHeaderBand(style({ headerText: "black" }));
      expect(black).toContain('font-weight:700;color:#000000">Acme Co</span>');
      expect(imgTag(black)).toContain("color:#000000");
    });

    it("Auto text reads across the gradient, not just colour 1", () => {
      const band = renderHeaderBand(style({ logo: null, headerColor: "#a78bfa", headerGradientColor: "#312e81" }));
      expect(band).toContain('color:#ffffff">Acme Co</span>');
    });

    it("a bad colour 2 draws solid, with the text judged on what's drawn", () => {
      const band = renderHeaderBand(style({ logo: null, headerColor: "#ffd400", headerGradientColor: "purple" }));
      expect(band).toBe(renderHeaderBand(style({ logo: null, headerColor: "#ffd400" })));
      expect(band).not.toContain("linear-gradient");
      expect(band).toContain("color:#000000");
    });

    it("a header colour that isn't #rrggbb draws #111111 with white text", () => {
      const band = renderHeaderBand(style({ logo: null, headerColor: "#fff" }));
      expect(band.match(/bgcolor="#111111"/g)).toHaveLength(2);
      expect(band).toContain('color:#ffffff">Acme Co</span>');
    });

    // Pinned byte-for-byte: with the header options on, a colour header (gradient or forced
    // text) must keep drawing exactly this.
    it("pins today's option bands: a gradient with Auto text, and forced white on a logo and name", () => {
      expect(renderHeaderBand(style({ headerColor: "#7c3aed", headerGradientColor: "#4f46e5" }))).toMatchInlineSnapshot(`"<!--[if mso]><table role="presentation" width="608" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]--><table role="presentation" width="100%" align="center" cellpadding="0" cellspacing="0" bgcolor="#7c3aed" style="width:100%;max-width:608px;margin:0 auto;background-color:#7c3aed"><tr><td bgcolor="#7c3aed" align="left" style="padding:16px 24px;background-color:#7c3aed;background-image:linear-gradient(135deg,#7c3aed,#4f46e5)"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="vertical-align:middle"><img src="https://app.example.com/api/brand-logo/tenant-1/11111111-2222-4333-8444-555555555555.png" width="120" height="40" alt="" style="display:block;width:120px;height:40px;border:0;outline:none;text-decoration:none;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#ffffff" /></td><td style="vertical-align:middle;padding-left:12px"><span style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#ffffff">Acme Co</span></td></tr></table></td></tr></table><!--[if mso]></td></tr></table><![endif]-->"`);
      expect(renderHeaderBand(style({ headerColor: "#ffd400", headerText: "white" }))).toMatchInlineSnapshot(`"<!--[if mso]><table role="presentation" width="608" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]--><table role="presentation" width="100%" align="center" cellpadding="0" cellspacing="0" bgcolor="#ffd400" style="width:100%;max-width:608px;margin:0 auto;background-color:#ffd400"><tr><td bgcolor="#ffd400" align="left" style="padding:16px 24px;background-color:#ffd400"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="vertical-align:middle"><img src="https://app.example.com/api/brand-logo/tenant-1/11111111-2222-4333-8444-555555555555.png" width="120" height="40" alt="" style="display:block;width:120px;height:40px;border:0;outline:none;text-decoration:none;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#ffffff" /></td><td style="vertical-align:middle;padding-left:12px"><span style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#ffffff">Acme Co</span></td></tr></table></td></tr></table><!--[if mso]></td></tr></table><![endif]-->"`);
    });

    it("pins today's styled shell with a gradient", () => {
      const gradient = style({ headerColor: "#7c3aed", headerGradientColor: "#4f46e5" });
      expect(wrap("<p>x</p>", null, { style: gradient })).toMatchInlineSnapshot(`
        "<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"></head><body style="margin:0;background:#f6f6f6">
          <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff">x</div><!--[if mso]><table role="presentation" width="608" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]--><table role="presentation" width="100%" align="center" cellpadding="0" cellspacing="0" bgcolor="#7c3aed" style="width:100%;max-width:608px;margin:0 auto;background-color:#7c3aed"><tr><td bgcolor="#7c3aed" align="left" style="padding:16px 24px;background-color:#7c3aed;background-image:linear-gradient(135deg,#7c3aed,#4f46e5)"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="vertical-align:middle"><img src="https://app.example.com/api/brand-logo/tenant-1/11111111-2222-4333-8444-555555555555.png" width="120" height="40" alt="" style="display:block;width:120px;height:40px;border:0;outline:none;text-decoration:none;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#ffffff" /></td><td style="vertical-align:middle;padding-left:12px"><span style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#ffffff">Acme Co</span></td></tr></table></td></tr></table><!--[if mso]></td></tr></table><![endif]-->
          <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;background:#fff">
            
            <p>x</p>
          </div>
        </body></html>"
      `);
    });
  });

  describe("header image", () => {
    const BANNER = "https://app.example.com/api/brand-asset/header/tenant-1/3f2504e0-4f89-41d3-9a0c-0305e82c3301.jpg";
    type Banner = NonNullable<ResolvedEmailStyle["headerImage"]>;
    const banner = (over: Partial<Banner> = {}): Banner => ({ url: BANNER, width: 1200, height: 300, ...over });
    const withImage = (over: Partial<ResolvedEmailStyle> = {}) => style({ headerImage: banner(), ...over });

    // Pinned byte-for-byte: the Image-mode band (the plan's markup, with the height attribute).
    it("pins the banner band: full width, no padding, on the header colour, alt = the name in the readable colour", () => {
      const band = renderHeaderBand(withImage());
      expect(band).toMatchInlineSnapshot(`"<!--[if mso]><table role="presentation" width="608" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]--><table role="presentation" width="100%" align="center" cellpadding="0" cellspacing="0" bgcolor="#123456" style="width:100%;max-width:608px;margin:0 auto;background-color:#123456"><tr><td bgcolor="#123456" align="center" style="padding:0;background-color:#123456"><img src="https://app.example.com/api/brand-asset/header/tenant-1/3f2504e0-4f89-41d3-9a0c-0305e82c3301.jpg" width="608" height="152" alt="Acme Co" style="display:block;width:100%;max-width:608px;height:auto;border:0;outline:none;text-decoration:none;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#ffffff" /></td></tr></table><!--[if mso]></td></tr></table><![endif]-->"`);
      expect(band.match(/bgcolor="#123456"/g)).toHaveLength(2);
      expect(band).toContain('style="padding:0;background-color:#123456"');
      const img = imgTag(band);
      expect(img).toContain('width="608"');
      expect(img).toContain('height="152"');
      expect(img).toContain("display:block;width:100%;max-width:608px;height:auto;border:0");
      expect(img).toContain('alt="Acme Co"');
      expect(img).toContain(`color:${readableOn("#123456")}`);
    });

    it("the height attribute is the banner's height at 608 wide, rounded, and at least 1", () => {
      expect(imgTag(renderHeaderBand(withImage({ headerImage: banner({ height: 301 }) })))).toContain('height="153"');
      expect(imgTag(renderHeaderBand(withImage({ headerImage: banner({ width: 600, height: 300 }) })))).toContain('height="304"');
      expect(imgTag(renderHeaderBand(withImage({ headerImage: banner({ height: 1 }) })))).toContain('height="1"');
    });

    it("a banner taller than it is wide shrinks to fit a 608 square, centred", () => {
      const square = imgTag(renderHeaderBand(withImage({ headerImage: banner({ width: 600, height: 600 }) })));
      expect(square).toContain('width="608" height="608"');
      expect(square).toContain("width:100%;max-width:608px");
      const portrait = imgTag(renderHeaderBand(withImage({ headerImage: banner({ width: 800, height: 2400 }) })));
      expect(portrait).toContain('width="203" height="608"');
      expect(portrait).toContain("display:block;margin:0 auto;width:203px;max-width:100%;height:auto");
      const sliver = imgTag(renderHeaderBand(withImage({ headerImage: banner({ width: 10, height: 2400 }) })));
      expect(sliver).toContain('width="3" height="608"');
    });

    it("the banner alone: no link, logo, name span or gradient, and forced text is ignored", () => {
      const band = renderHeaderBand(withImage({ headerGradientColor: "#4f46e5", headerText: "black" }));
      expect(band).toBe(renderHeaderBand(withImage()));
      expect(band).not.toContain("<a");
      expect(band).not.toContain("<span");
      expect(band).not.toContain("linear-gradient");
      expect(band).not.toContain("/api/brand-logo/");
      expect(band.match(/<img\b/g)).toHaveLength(1);
      expect(renderHeaderBand(withImage({ logo: null, name: null }))).toBe(band);
      // On a light header colour the alt turns black, even with white forced for the colour band.
      const light = renderHeaderBand(withImage({ headerColor: "#ffd400", headerText: "white" }));
      expect(imgTag(light)).toContain("color:#000000");
      expect(light.match(/bgcolor="#ffd400"/g)).toHaveLength(2);
      // A header colour that isn't #rrggbb sits on #111111, as the colour band does.
      expect(renderHeaderBand(withImage({ headerColor: "#fff" })).match(/bgcolor="#111111"/g)).toHaveLength(2);
    });

    it("a URL of the wrong shape or an out-of-range size gives exactly the colour band — never a broken image", () => {
      const colour = renderHeaderBand(style({ headerGradientColor: "#4f46e5" }));
      for (const headerImage of [
        banner({ url: LOGO_URL }),
        banner({ url: BANNER.replace("https:", "http:") }),
        banner({ url: `${BANNER}?v=2` }),
        banner({ url: BANNER.replace(".jpg", ".webp") }),
        banner({ url: BANNER.replace("/header/", "/graphic/") }),
        banner({ url: "https://cdn.example.com/banner.jpg" }),
        banner({ url: BANNER.replace("https://app.example.com", "") }),
        banner({ width: 1201 }),
        banner({ height: 2401 }),
        banner({ width: 0 }),
        banner({ width: 1200.5 }),
      ]) {
        expect(renderHeaderBand(style({ headerGradientColor: "#4f46e5", headerImage }))).toBe(colour);
      }
    });

    it("wrap keeps the preheader before the band, and still skips the band when the body shows a brand logo", () => {
      const out = wrap("<p>x</p>", null, { style: withImage(), preheader: "Your week in brief" });
      const band = renderHeaderBand(withImage());
      expect(out).toContain(band);
      expect(out.indexOf("Your week in brief")).toBeLessThan(out.indexOf(band));
      expect(out.indexOf(band)).toBeLessThan(out.indexOf("max-width:560px"));
      expect(out.match(/Your week in brief/g)).toHaveLength(1);

      const own = wrap(`<p><img src="${LOGO_URL}" alt=""></p>`, null, { style: withImage() });
      expect(own).not.toContain(BANNER);
      expect(own).not.toContain('bgcolor="#123456"');
      expect(own).toContain("color-scheme");
    });

    it("escapes the alt text, including Mailchimp's pipes, and an empty name gives an empty alt", () => {
      const band = renderHeaderBand(withImage({ altName: 'Acme" onerror="x *|FNAME|*' }));
      expect(imgTag(band)).toContain('alt="Acme&quot; onerror=&quot;x *&#124;FNAME&#124;*"');
      expect(band).not.toContain("*|");
      expect(imgTag(renderHeaderBand(withImage({ name: null, altName: "" })))).toContain('alt=""');
    });
  });

  it("pins today's styled shell", () => {
    expect(wrap("<p>x</p>", null, { style: style() })).toMatchInlineSnapshot(`
      "<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"></head><body style="margin:0;background:#f6f6f6">
        <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff">x</div><!--[if mso]><table role="presentation" width="608" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]--><table role="presentation" width="100%" align="center" cellpadding="0" cellspacing="0" bgcolor="#123456" style="width:100%;max-width:608px;margin:0 auto;background-color:#123456"><tr><td bgcolor="#123456" align="left" style="padding:16px 24px;background-color:#123456"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="vertical-align:middle"><img src="https://app.example.com/api/brand-logo/tenant-1/11111111-2222-4333-8444-555555555555.png" width="120" height="40" alt="" style="display:block;width:120px;height:40px;border:0;outline:none;text-decoration:none;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#ffffff" /></td><td style="vertical-align:middle;padding-left:12px"><span style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#ffffff">Acme Co</span></td></tr></table></td></tr></table><!--[if mso]></td></tr></table><![endif]-->
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;background:#fff">
          
          <p>x</p>
        </div>
      </body></html>"
    `);
  });
});

// Pinned byte-for-byte: themes, fonts and layout buttons that follow the Email style are coming
// behind flags, and with them off (or no theme saved) every block, footer and shell must stay this.
describe("today's layouts, footer and shells", () => {
  const LOGO_URL = "https://app.example.com/api/brand-logo/tenant-1/11111111-2222-4333-8444-555555555555.png";
  const style = (over: Partial<ResolvedEmailStyle> = {}): ResolvedEmailStyle => ({
    logo: { url: LOGO_URL, width: 120, height: 40 },
    name: "Acme Co",
    altName: "Acme Co",
    headerColor: "#123456",
    accentColor: "#ff6600",
    ...over,
  });
  // Every block kind, with buttons in the default #111111, the presets' #4f46e5 and a brand palette colour.
  const layout = EmailLayoutSchema.parse({
    blocks: [
      { id: "h1", kind: "heading", html: "Welcome, {{first_name}}", level: 1, align: "center" },
      { id: "h2", kind: "heading", html: "What's <new>", level: 2, align: "left", color: "#0b1f3a", sectionBg: "#f5f5f5" },
      { id: "h3", kind: "heading", html: "Small print", level: 3, align: "right" },
      { id: "t1", kind: "text", role: "copy", html: "<p>Hi {{first_name}}, here's <strong>the news</strong>.</p>" },
      { id: "t2", kind: "text", html: "<p>Coloured copy</p>", color: "#333333", sectionBg: "#eef2ff" },
      { id: "i1", kind: "image", src: "https://cdn.example.com/hero.png", alt: "Hero", href: "https://example.com/launch", width: 560, align: "center" },
      { id: "i2", kind: "image", src: "https://cdn.example.com/badge.png", alt: "", href: null, width: 120, align: "left" },
      { id: "b1", kind: "button", label: "Get started", href: "{{hub_url}}", align: "center", bg: "#111111", color: "#ffffff", radius: 8 },
      { id: "b2", kind: "button", label: "See what's new", href: "https://example.com/new", align: "left", bg: "#4f46e5", color: "#ffffff", radius: 6 },
      { id: "b3", kind: "button", label: "Book a call", href: "https://example.com/book", align: "right", bg: "#ff6b35", color: "#111111", radius: 24, sectionBg: "#fff7ed" },
      { id: "d1", kind: "divider", color: "#e5e5e5", thickness: 1 },
      { id: "d2", kind: "divider", color: "#4f46e5", thickness: 3, sectionBg: "#f5f5f5" },
      { id: "s1", kind: "spacer", height: 24 },
      { id: "so", kind: "social", align: "center", links: [{ platform: "x", url: "https://example.com/social/x" }, { platform: "linkedin", url: "https://example.com/social/linkedin" }] },
      { id: "f1", kind: "footer", text: "", sectionBg: "#fafafa" },
    ],
  });

  it("pins every block kind", () => {
    expect(renderEmailLayout(layout)).toMatchInlineSnapshot(`
      "<h1 style="margin:0 0 12px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:28px;line-height:1.3;font-weight:700;color:#111111;text-align:center">Welcome, {{first_name}}</h1>
      <div style="background:#f5f5f5;padding:16px 16px 1px"><h2 style="margin:0 0 12px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:22px;line-height:1.3;font-weight:700;color:#0b1f3a;text-align:left">What&#39;s &lt;new&gt;</h2></div>
      <h3 style="margin:0 0 12px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#111111;text-align:right">Small print</h3>
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;line-height:1.6;color:#111111;margin:0 0 16px"><p>Hi {{first_name}}, here's <strong>the news</strong>.</p></div>
      <div style="background:#eef2ff;padding:16px 16px 1px"><div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;line-height:1.6;color:#333333;margin:0 0 16px"><p>Coloured copy</p></div></div>
      <div style="text-align:center;margin:0 0 16px"><a href="https://example.com/launch" target="_blank" rel="noopener noreferrer"><img src="https://cdn.example.com/hero.png" alt="Hero" width="560" style="display:inline-block;width:560px;max-width:100%;height:auto;border:0;border-radius:8px" /></a></div>
      <div style="text-align:left;margin:0 0 16px"><img src="https://cdn.example.com/badge.png" alt="" width="120" style="display:inline-block;width:120px;max-width:100%;height:auto;border:0;border-radius:8px" /></div>
      <div style="text-align:center;margin:0 0 16px"><table role="presentation" cellpadding="0" cellspacing="0" style="display:inline-block;border-collapse:separate"><tr><td style="background:#111111;border-radius:8px"><a href="{{hub_url}}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">Get started</a></td></tr></table></div>
      <div style="text-align:left;margin:0 0 16px"><table role="presentation" cellpadding="0" cellspacing="0" style="display:inline-block;border-collapse:separate"><tr><td style="background:#4f46e5;border-radius:6px"><a href="https://example.com/new" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">See what&#39;s new</a></td></tr></table></div>
      <div style="background:#fff7ed;padding:16px 16px 1px"><div style="text-align:right;margin:0 0 16px"><table role="presentation" cellpadding="0" cellspacing="0" style="display:inline-block;border-collapse:separate"><tr><td style="background:#ff6b35;border-radius:24px"><a href="https://example.com/book" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;font-weight:600;color:#111111;text-decoration:none">Book a call</a></td></tr></table></div></div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border-collapse:collapse"><tr><td style="border-top:1px solid #e5e5e5;font-size:0;line-height:0">&nbsp;</td></tr></table>
      <div style="background:#f5f5f5;padding:16px 16px 1px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border-collapse:collapse"><tr><td style="border-top:3px solid #4f46e5;font-size:0;line-height:0">&nbsp;</td></tr></table></div>
      <div style="height:24px;line-height:24px;font-size:0">&nbsp;</div>
      <div style="text-align:center;margin:8px 0 16px"><a href="https://example.com/social/x" target="_blank" rel="noopener noreferrer" style="display:inline-block;margin:0 6px"><img src="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22%3E%3Crect%20width%3D%2224%22%20height%3D%2224%22%20rx%3D%225%22%20fill%3D%22%238a8a8a%22%2F%3E%3Ctext%20x%3D%2212%22%20y%3D%2217%22%20font-family%3D%22Arial%2CHelvetica%2Csans-serif%22%20font-size%3D%2210%22%20font-weight%3D%22700%22%20fill%3D%22%23ffffff%22%20text-anchor%3D%22middle%22%3E%F0%9D%95%8F%3C%2Ftext%3E%3C%2Fsvg%3E" alt="X" width="24" height="24" style="display:inline-block;border:0" /></a><a href="https://example.com/social/linkedin" target="_blank" rel="noopener noreferrer" style="display:inline-block;margin:0 6px"><img src="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22%3E%3Crect%20width%3D%2224%22%20height%3D%2224%22%20rx%3D%225%22%20fill%3D%22%238a8a8a%22%2F%3E%3Ctext%20x%3D%2212%22%20y%3D%2217%22%20font-family%3D%22Arial%2CHelvetica%2Csans-serif%22%20font-size%3D%2210%22%20font-weight%3D%22700%22%20fill%3D%22%23ffffff%22%20text-anchor%3D%22middle%22%3Ein%3C%2Ftext%3E%3C%2Fsvg%3E" alt="Linkedin" width="24" height="24" style="display:inline-block;border:0" /></a></div>
      <div style="background:#fafafa;padding:16px 16px 1px"><div data-vzb-footer="1" style="text-align:center;margin:28px 0 0;padding-top:20px;border-top:1px solid #ededed;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:12px;line-height:1.7;color:#999999">This email was sent by {{sender_brand}}.<br /><a href="{{manage_preferences_url}}" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Manage preferences</a> &nbsp;|&nbsp; <a href="{{unsubscribe_url}}" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Unsubscribe</a> &nbsp;|&nbsp; <a href="{{privacy_url}}" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Privacy Policy</a></div></div>"
    `);
  });

  it("pins the Create preview shell (a layout in wrap), with and without a style", () => {
    const inner = renderEmailLayout(
      EmailLayoutSchema.parse({
        blocks: [
          { id: "h1", kind: "heading", html: "Welcome", level: 2, align: "left" },
          { id: "t1", kind: "text", role: "copy", html: "<p>Hi there.</p>" },
          { id: "b1", kind: "button", label: "Get started", href: "https://example.com/start", align: "center", bg: "#4f46e5", color: "#ffffff", radius: 8 },
          { id: "f1", kind: "footer", text: "" },
        ],
      }),
    );
    expect(wrap(inner, null)).toMatchInlineSnapshot(`
      "<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="margin:0;background:#f6f6f6">
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;background:#fff">
          
          <h2 style="margin:0 0 12px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:22px;line-height:1.3;font-weight:700;color:#111111;text-align:left">Welcome</h2>
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;line-height:1.6;color:#111111;margin:0 0 16px"><p>Hi there.</p></div>
      <div style="text-align:center;margin:0 0 16px"><table role="presentation" cellpadding="0" cellspacing="0" style="display:inline-block;border-collapse:separate"><tr><td style="background:#4f46e5;border-radius:8px"><a href="https://example.com/start" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">Get started</a></td></tr></table></div>
      <div data-vzb-footer="1" style="text-align:center;margin:28px 0 0;padding-top:20px;border-top:1px solid #ededed;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:12px;line-height:1.7;color:#999999">This email was sent by {{sender_brand}}.<br /><a href="{{manage_preferences_url}}" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Manage preferences</a> &nbsp;|&nbsp; <a href="{{unsubscribe_url}}" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Unsubscribe</a> &nbsp;|&nbsp; <a href="{{privacy_url}}" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Privacy Policy</a></div>
        </div>
      </body></html>"
    `);
    expect(wrap(inner, null, { style: style() })).toMatchInlineSnapshot(`
      "<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"></head><body style="margin:0;background:#f6f6f6">
        <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff">Welcome Hi there. Get started This email was sent by {{sender_brand}}. Manage preferences &nbsp;|&nbsp; Unsubscribe &nbsp;|&nbsp; Privacy Policy</div><!--[if mso]><table role="presentation" width="608" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]--><table role="presentation" width="100%" align="center" cellpadding="0" cellspacing="0" bgcolor="#123456" style="width:100%;max-width:608px;margin:0 auto;background-color:#123456"><tr><td bgcolor="#123456" align="left" style="padding:16px 24px;background-color:#123456"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="vertical-align:middle"><img src="https://app.example.com/api/brand-logo/tenant-1/11111111-2222-4333-8444-555555555555.png" width="120" height="40" alt="" style="display:block;width:120px;height:40px;border:0;outline:none;text-decoration:none;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#ffffff" /></td><td style="vertical-align:middle;padding-left:12px"><span style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#ffffff">Acme Co</span></td></tr></table></td></tr></table><!--[if mso]></td></tr></table><![endif]-->
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;background:#fff">
          
          <h2 style="margin:0 0 12px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:22px;line-height:1.3;font-weight:700;color:#111111;text-align:left">Welcome</h2>
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;line-height:1.6;color:#111111;margin:0 0 16px"><p>Hi there.</p></div>
      <div style="text-align:center;margin:0 0 16px"><table role="presentation" cellpadding="0" cellspacing="0" style="display:inline-block;border-collapse:separate"><tr><td style="background:#4f46e5;border-radius:8px"><a href="https://example.com/start" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">Get started</a></td></tr></table></div>
      <div data-vzb-footer="1" style="text-align:center;margin:28px 0 0;padding-top:20px;border-top:1px solid #ededed;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:12px;line-height:1.7;color:#999999">This email was sent by {{sender_brand}}.<br /><a href="{{manage_preferences_url}}" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Manage preferences</a> &nbsp;|&nbsp; <a href="{{unsubscribe_url}}" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Unsubscribe</a> &nbsp;|&nbsp; <a href="{{privacy_url}}" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Privacy Policy</a></div>
        </div>
      </body></html>"
    `);
  });

  it("pins the footer: plain, on a section colour, and with the postal address", () => {
    expect(renderFooter()).toMatchInlineSnapshot(`"<div data-vzb-footer="1" style="text-align:center;margin:28px 0 0;padding-top:20px;border-top:1px solid #ededed;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:12px;line-height:1.7;color:#999999">This email was sent by {{sender_brand}}.<br /><a href="{{manage_preferences_url}}" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Manage preferences</a> &nbsp;|&nbsp; <a href="{{unsubscribe_url}}" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Unsubscribe</a> &nbsp;|&nbsp; <a href="{{privacy_url}}" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Privacy Policy</a></div>"`);
    expect(renderFooter("#f5f5f5")).toMatchInlineSnapshot(`"<div style="background:#f5f5f5;padding:16px 16px 1px"><div data-vzb-footer="1" style="text-align:center;margin:28px 0 0;padding-top:20px;border-top:1px solid #ededed;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:12px;line-height:1.7;color:#999999">This email was sent by {{sender_brand}}.<br /><a href="{{manage_preferences_url}}" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Manage preferences</a> &nbsp;|&nbsp; <a href="{{unsubscribe_url}}" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Unsubscribe</a> &nbsp;|&nbsp; <a href="{{privacy_url}}" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Privacy Policy</a></div></div>"`);
    expect(renderFooter(null, { withAddress: true })).toMatchInlineSnapshot(`"<div data-vzb-footer="1" style="text-align:center;margin:28px 0 0;padding-top:20px;border-top:1px solid #ededed;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:12px;line-height:1.7;color:#999999">This email was sent by {{sender_brand}}.<br />{{postal_address}}<br /><a href="{{manage_preferences_url}}" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Manage preferences</a> &nbsp;|&nbsp; <a href="{{unsubscribe_url}}" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Unsubscribe</a> &nbsp;|&nbsp; <a href="{{privacy_url}}" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Privacy Policy</a></div>"`);
  });

  it("pins the styled shell with a preheader and a hero, the name alone, and a body with its own logo", () => {
    expect(wrap("<p>x</p>", "https://cdn.example.com/hero.png", { style: style(), preheader: "Your week in brief" })).toMatchInlineSnapshot(`
      "<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"></head><body style="margin:0;background:#f6f6f6">
        <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff">Your week in brief</div><!--[if mso]><table role="presentation" width="608" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]--><table role="presentation" width="100%" align="center" cellpadding="0" cellspacing="0" bgcolor="#123456" style="width:100%;max-width:608px;margin:0 auto;background-color:#123456"><tr><td bgcolor="#123456" align="left" style="padding:16px 24px;background-color:#123456"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="vertical-align:middle"><img src="https://app.example.com/api/brand-logo/tenant-1/11111111-2222-4333-8444-555555555555.png" width="120" height="40" alt="" style="display:block;width:120px;height:40px;border:0;outline:none;text-decoration:none;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#ffffff" /></td><td style="vertical-align:middle;padding-left:12px"><span style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#ffffff">Acme Co</span></td></tr></table></td></tr></table><!--[if mso]></td></tr></table><![endif]-->
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;background:#fff">
          <img src="https://cdn.example.com/hero.png" alt="" style="display:block;width:100%;max-width:560px;border-radius:12px;margin:0 0 20px"/>
          <p>x</p>
        </div>
      </body></html>"
    `);
    expect(wrap("<p>x</p>", null, { style: style({ logo: null }) })).toMatchInlineSnapshot(`
      "<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"></head><body style="margin:0;background:#f6f6f6">
        <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff">x</div><!--[if mso]><table role="presentation" width="608" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]--><table role="presentation" width="100%" align="center" cellpadding="0" cellspacing="0" bgcolor="#123456" style="width:100%;max-width:608px;margin:0 auto;background-color:#123456"><tr><td bgcolor="#123456" align="left" style="padding:16px 24px;background-color:#123456"><span style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#ffffff">Acme Co</span></td></tr></table><!--[if mso]></td></tr></table><![endif]-->
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;background:#fff">
          
          <p>x</p>
        </div>
      </body></html>"
    `);
    expect(wrap(`<p><img src="${LOGO_URL}" alt=""></p>`, null, { style: style() })).toMatchInlineSnapshot(`
      "<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"></head><body style="margin:0;background:#f6f6f6">
        
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;background:#fff">
          
          <p><img src="https://app.example.com/api/brand-logo/tenant-1/11111111-2222-4333-8444-555555555555.png" alt=""></p>
        </div>
      </body></html>"
    `);
  });

  it("pins the letter shell", () => {
    expect(wrapLetter("<p>Hi Jo,</p>\n<p>Just a note.</p>")).toMatchInlineSnapshot(`
      "<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="margin:0;background:#ffffff">
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;max-width:560px;margin:0 auto;padding:24px;color:#111">
          <p>Hi Jo,</p>
      <p>Just a note.</p>
        </div>
      </body></html>"
    `);
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
