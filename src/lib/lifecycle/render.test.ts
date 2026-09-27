import { describe, it, expect } from "vitest";
import { FOOTER_MARKER } from "@/lib/email/emailRender";
import type { ResolvedEmailStyle } from "@/lib/email/emailStyle";
import { EmailLayoutSchema } from "@/lib/types/emailLayout";
import { renderLifecycleEmail, type RenderValues } from "./render";

const UNSUB = "https://mk.test/unsubscribe?u=tok123";

function values(over: Partial<RenderValues> = {}): RenderValues {
  return {
    user: { id: "u_1", first_name: "Alex", last_name: "Doe", email: "alex@acme.test" },
    product: { name: "Vizzybl" },
    traits: { plan: "pro" },
    facts: [
      { id: "sov", label: "Share of voice", value: 12, unit: "%", display: null },
      { id: "answers", label: "Answers", value: 3, display: "3 of 10 answers" },
    ],
    nextStep: { label: "Run your first audit", url: "https://app.vizzybl.test/audits?new=1" },
    checklist: [
      { label: "Add your brand", done: true, url: "https://app.vizzybl.test/brand" },
      { label: "Run an audit", done: false, url: "https://app.vizzybl.test/audits?new=1" },
      { label: "Monitor prompts", done: false, url: null },
    ],
    insight: { sentence: "ChatGPT mentioned you in 3 of 10 answers.", aiLine: null },
    footer: {
      brand: "Vizzybl",
      unsubscribeUrl: UNSUB,
      managePreferencesUrl: UNSUB,
      privacyUrl: "https://vizzybl.test/privacy",
      postalAddress: "1 High St, London",
    },
    ...over,
  };
}

type Item = Parameters<typeof renderLifecycleEmail>[0]["item"];
function item(over: Partial<Item> = {}): Item {
  return {
    subject: "Hi {{user.first_name|there}}",
    body: "Hello {{user.first_name|there}},\n\n{{block.checklist}}\n\n{{block.next_step}}",
    previewText: "{{onboarding.steps_remaining}} steps left",
    format: "branded",
    layout: null,
    ...over,
  };
}

const count = (s: string, needle: string) => s.split(needle).length - 1;

describe("renderLifecycleEmail", () => {
  it("fills tokens and reports nothing missing", () => {
    const r = renderLifecycleEmail({ item: item(), values: values() });
    expect(r.subject).toBe("Hi Alex");
    expect(r.html).toContain("Hello Alex,");
    expect(r.html).toContain("2 steps left"); // preheader
    expect(r.missing).toEqual([]);
  });

  it("uses the fallback when a value is absent, and never leaks braces, undefined or null", () => {
    const r = renderLifecycleEmail({
      item: item({ body: "Hi {{user.first_name|there}} on {{trait.plan}} — {{fact.nope}} {{trait.missing}}" }),
      values: values({ user: { id: "u_1", first_name: null }, traits: { plan: null } }),
    });
    expect(r.subject).toBe("Hi there");
    expect(r.html).toContain("Hi there on");
    expect(r.missing.sort()).toEqual(["fact.nope", "trait.missing", "trait.plan"]);
    for (const out of [r.html, r.text, r.subject]) {
      expect(out).not.toContain("{{");
      expect(out).not.toContain("undefined");
      expect(out).not.toMatch(/\bnull\b/);
    }
  });

  it("escapes values in the body, but keeps the author's own markup", () => {
    const r = renderLifecycleEmail({
      item: item({ body: "<p>Hi <strong>{{user.first_name}}</strong></p>" }),
      values: values({ user: { id: "u_1", first_name: '<img src=x onerror="alert(1)">' } }),
    });
    expect(r.html).toContain("<strong>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</strong>");
    expect(r.html).not.toContain("<img src=x");
  });

  it("is single-pass: a value that looks like a token stays literal", () => {
    const r = renderLifecycleEmail({
      item: item({ body: "Hi {{user.first_name}}" }),
      values: values({ user: { id: "u_1", first_name: "{{user.email}}", email: "secret@acme.test" } }),
    });
    expect(r.html).toContain("Hi {{user.email}}");
    expect(r.html).not.toContain("secret@acme.test");
  });

  it("keeps the subject on one line", () => {
    const r = renderLifecycleEmail({
      item: item(),
      values: values({ user: { id: "u_1", first_name: "Al\r\nBcc: evil@x.test" } }),
    });
    expect(r.subject).not.toMatch(/[\r\n]/);
  });

  it("renders values: facts, onboarding counts, product and next step", () => {
    const r = renderLifecycleEmail({
      item: item({
        body: "{{fact.sov}} · {{fact.answers}} · {{onboarding.steps_done}}/{{onboarding.steps_total}} · {{product.name}} · {{next_step.label}}",
      }),
      values: values(),
    });
    expect(r.html).toContain("12% · 3 of 10 answers · 1/3 · Vizzybl · Run your first audit");
  });

  it("does not reach inherited properties through trait names", () => {
    const r = renderLifecycleEmail({ item: item({ body: "x{{trait.constructor}}y" }), values: values() });
    expect(r.html).toContain("xy");
    expect(r.html).not.toContain("function");
    expect(r.missing).toEqual(["trait.constructor"]);
  });

  describe("blocks", () => {
    it("checklist: ✓ for done, ☐ with a link for steps still to do", () => {
      const r = renderLifecycleEmail({ item: item({ body: "{{block.checklist}}" }), values: values() });
      expect(count(r.html, "✓")).toBe(1);
      expect(count(r.html, "☐")).toBe(2);
      expect(r.html).toContain('href="https://app.vizzybl.test/audits?new=1"');
      expect(r.html).not.toContain('href="https://app.vizzybl.test/brand"'); // done steps aren't links
      // A block alone in a paragraph is unwrapped (no table inside a <p>).
      expect(r.html).not.toMatch(/<p>\s*<table/);
    });

    it("next step: a button in branded emails, a plain link in letters", () => {
      const branded = renderLifecycleEmail({ item: item({ body: "{{block.next_step}}" }), values: values() });
      expect(branded.html).toContain("background:#111111");
      const letter = renderLifecycleEmail({ item: item({ body: "{{block.next_step}}", format: "letter" }), values: values() });
      expect(letter.html).not.toContain("background:#111111");
      expect(letter.html).toContain('<a href="https://app.vizzybl.test/audits?new=1"');
    });

    it("insight: the product's sentence, plus the approved AI line when there is one", () => {
      const r = renderLifecycleEmail({
        item: item({ body: "{{block.insight}}" }),
        values: values({ insight: { sentence: "You appear in 3 of 10 answers.", aiLine: "Most came from review sites." } }),
      });
      expect(r.html).toContain("You appear in 3 of 10 answers. Most came from review sites.");
    });

    it("an absent block renders nothing and is not 'missing'; an unknown block is", () => {
      const r = renderLifecycleEmail({
        item: item({ body: "a{{block.insight}}b{{block.next_step}}c{{block.bogus}}" }),
        values: values({ insight: null, nextStep: null }),
      });
      expect(r.html).toContain("abc");
      expect(r.missing).toEqual(["block.bogus"]);
    });
  });

  describe("links", () => {
    it("drops an unsafe next-step URL: no link, and the url token counts as missing", () => {
      const r = renderLifecycleEmail({
        item: item({ body: '{{block.next_step}} <a href="{{next_step.url}}">go</a>' }),
        values: values({ nextStep: { label: "Go", url: "javascript:alert(1)" } }),
      });
      expect(r.html).not.toContain("javascript:");
      expect(r.html).toContain('href="#"');
      expect(r.missing).toEqual(["next_step.url"]);
    });

    it("neutralises an href built from an untrusted value", () => {
      const r = renderLifecycleEmail({
        item: item({ body: '<p><a href="{{trait.site}}">site</a></p>' }),
        values: values({ traits: { site: "javascript:alert(document.cookie)" } }),
      });
      expect(r.html).not.toContain("javascript:");
      expect(r.html).toContain('<a href="#">site</a>');
    });
  });

  describe("footer", () => {
    it("appends one footer with the postal address; the text part keeps the unsubscribe link", () => {
      const r = renderLifecycleEmail({ item: item(), values: values() });
      expect(count(r.html, FOOTER_MARKER)).toBe(1);
      expect(r.html).toContain("1 High St, London");
      expect(r.html).toContain(`href="${UNSUB}"`);
      expect(r.text).toContain(`Unsubscribe (${UNSUB})`);
      expect(r.text).toContain("1 High St, London");
    });

    it("omits the address line when none is configured", () => {
      const v = values();
      const r = renderLifecycleEmail({ item: item(), values: { ...v, footer: { ...v.footer, postalAddress: null } } });
      expect(r.html).not.toContain("postal_address");
      expect(r.missing).toEqual([]);
    });

    it("does not add a second footer when the body already has one", () => {
      const r = renderLifecycleEmail({
        item: item({ body: '<p>Hi</p><div data-vzb-footer="1"><a href="{{unsubscribe_url}}">Unsubscribe</a></div>' }),
        values: values(),
      });
      expect(count(r.html, FOOTER_MARKER)).toBe(1);
      expect(r.html).toContain(`href="${UNSUB}"`);
    });
  });

  it("letters use the plain shell, branded emails the card", () => {
    const letter = renderLifecycleEmail({ item: item({ format: "letter" }), values: values() });
    const branded = renderLifecycleEmail({ item: item(), values: values() });
    expect(letter.html).toContain("background:#ffffff");
    expect(branded.html).toContain("background:#f6f6f6");
  });

  it("renders a saved layout rather than the stored body", () => {
    const r = renderLifecycleEmail({
      item: item({
        body: "STALE BODY",
        layout: EmailLayoutSchema.parse({
          blocks: [{ id: "b1", kind: "text", html: "<p>Fresh {{user.first_name}}</p>" }],
        }),
      }),
      values: values(),
    });
    expect(r.html).not.toContain("STALE BODY");
    expect(r.html).toContain("Fresh Alex");
  });

  it("shadow mode: a banner names the real recipient, in the HTML and text parts", () => {
    const r = renderLifecycleEmail({ item: item(), values: values(), shadowFor: "alex@acme.test" });
    expect(r.html).toContain("Shadow mode");
    expect(r.html).toContain("alex@acme.test");
    expect(r.text).toContain("Shadow mode");
  });

  // Pinned byte-for-byte: with no Email style saved, sends must stay exactly this.
  describe("today's output", () => {
    const pinned = values({
      product: { name: "Example App" },
      nextStep: { label: "Run your first audit", url: "https://app.example.com/audits?new=1" },
      checklist: [
        { label: "Add your brand", done: true, url: "https://app.example.com/brand" },
        { label: "Run an audit", done: false, url: "https://app.example.com/audits?new=1" },
        { label: "Monitor prompts", done: false, url: null },
      ],
      insight: { sentence: "ChatGPT mentioned you in 3 of 10 answers.", aiLine: "Most came from review sites." },
      footer: {
        brand: "Example Co",
        unsubscribeUrl: "https://app.example.com/unsubscribe?u=tok123",
        managePreferencesUrl: "https://app.example.com/preferences?u=tok123",
        privacyUrl: "https://example.com/privacy",
        postalAddress: "1 Example Street, London",
      },
    });

    it("branded, with a preheader, checklist, insight and next step", () => {
      const r = renderLifecycleEmail({
        item: item({
          subject: "Welcome to {{product.name}}, {{user.first_name|there}}",
          body: [
            "<p>Hi {{user.first_name|there}},</p>",
            "<p>Welcome to {{product.name}}. Here's where you are:</p>",
            "{{block.checklist}}",
            "{{block.insight}}",
            "{{block.next_step}}",
            "<p>Reply to this email if anything gets in your way.</p>",
          ].join("\n"),
          previewText: "{{onboarding.steps_remaining}} steps left",
        }),
        values: pinned,
      });
      expect(r.missing).toEqual([]);
      expect(r.html).toMatchInlineSnapshot(`
        "<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="margin:0;background:#f6f6f6">
          <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;background:#fff">
            
            <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff">2 steps left</div><p>Hi Alex,</p>
        <p>Welcome to Example App. Here's where you are:</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 16px;border-collapse:collapse"><tr><td style="padding:4px 10px 4px 0;font-size:16px;vertical-align:top">✓</td><td style="padding:4px 0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#8a8a8a;text-decoration:line-through">Add your brand</td></tr><tr><td style="padding:4px 10px 4px 0;font-size:16px;vertical-align:top">☐</td><td style="padding:4px 0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#111"><a href="https://app.example.com/audits?new=1" target="_blank" rel="noopener noreferrer" style="color:#111;text-decoration:underline">Run an audit</a></td></tr><tr><td style="padding:4px 10px 4px 0;font-size:16px;vertical-align:top">☐</td><td style="padding:4px 0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#111">Monitor prompts</td></tr></table>
        <div style="margin:8px 0 16px;padding:12px 14px;border-left:3px solid #111;background:#f6f6f6;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#111">ChatGPT mentioned you in 3 of 10 answers. Most came from review sites.</div>
        <div style="margin:8px 0 20px"><table role="presentation" cellpadding="0" cellspacing="0" style="display:inline-block;border-collapse:separate"><tr><td bgcolor="#111111" style="background:#111111;border-radius:8px"><a href="https://app.example.com/audits?new=1" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">Run your first audit →</a></td></tr></table></div>
        <p>Reply to this email if anything gets in your way.</p><div data-vzb-footer="1" style="text-align:center;margin:28px 0 0;padding-top:20px;border-top:1px solid #ededed;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:12px;line-height:1.7;color:#999999">This email was sent by Example Co.<br />1 Example Street, London<br /><a href="https://app.example.com/preferences?u=tok123" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Manage preferences</a> &nbsp;|&nbsp; <a href="https://app.example.com/unsubscribe?u=tok123" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Unsubscribe</a> &nbsp;|&nbsp; <a href="https://example.com/privacy" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Privacy Policy</a></div>
          </div>
        </body></html>"
      `);
      expect(r.text).toMatchInlineSnapshot(`
        "Hi Alex,

        Welcome to Example App. Here's where you are:

        ✓Add your brand☐Run an audit (https://app.example.com/audits?new=1)☐Monitor prompts
        ChatGPT mentioned you in 3 of 10 answers. Most came from review sites.

        Run your first audit → (https://app.example.com/audits?new=1)

        Reply to this email if anything gets in your way.
        This email was sent by Example Co.
        1 Example Street, London
        Manage preferences (https://app.example.com/preferences?u=tok123) | Unsubscribe (https://app.example.com/unsubscribe?u=tok123) | Privacy Policy (https://example.com/privacy)"
      `);
    });

    it("letter, from a plain-text body", () => {
      const r = renderLifecycleEmail({
        item: item({
          subject: "Your next step: {{next_step.label}}",
          body: "Hi {{user.first_name|there}},\n\nYou're one step closer. Here's what's next:\n\n{{block.next_step}}\n\n{{block.insight}}\n\nStuck? Just reply.",
          previewText: "It takes a few minutes",
          format: "letter",
        }),
        values: pinned,
      });
      expect(r.missing).toEqual([]);
      expect(r.html).toMatchInlineSnapshot(`
        "<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="margin:0;background:#ffffff">
          <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;max-width:560px;margin:0 auto;padding:24px;color:#111">
            <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff">It takes a few minutes</div><p>Hi Alex,</p>
        <p>You&#39;re one step closer. Here&#39;s what&#39;s next:</p>
        <p style="margin:0 0 16px"><a href="https://app.example.com/audits?new=1" target="_blank" rel="noopener noreferrer">Run your first audit →</a></p>
        <p style="margin:0 0 16px">ChatGPT mentioned you in 3 of 10 answers. Most came from review sites.</p>
        <p>Stuck? Just reply.</p><div data-vzb-footer="1" style="text-align:center;margin:28px 0 0;padding-top:20px;border-top:1px solid #ededed;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:12px;line-height:1.7;color:#999999">This email was sent by Example Co.<br />1 Example Street, London<br /><a href="https://app.example.com/preferences?u=tok123" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Manage preferences</a> &nbsp;|&nbsp; <a href="https://app.example.com/unsubscribe?u=tok123" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Unsubscribe</a> &nbsp;|&nbsp; <a href="https://example.com/privacy" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Privacy Policy</a></div>
          </div>
        </body></html>"
      `);
      expect(r.text).toMatchInlineSnapshot(`
        "Hi Alex,

        You're one step closer. Here's what's next:

        Run your first audit → (https://app.example.com/audits?new=1)

        ChatGPT mentioned you in 3 of 10 answers. Most came from review sites.

        Stuck? Just reply.
        This email was sent by Example Co.
        1 Example Street, London
        Manage preferences (https://app.example.com/preferences?u=tok123) | Unsubscribe (https://app.example.com/unsubscribe?u=tok123) | Privacy Policy (https://example.com/privacy)"
      `);
    });
  });

  describe("Email style", () => {
    const LOGO_URL = "https://app.example.com/api/brand-logo/ten_1/11111111-2222-4333-8444-555555555555.png";
    const style = (over: Partial<ResolvedEmailStyle> = {}): ResolvedEmailStyle => ({
      logo: { url: LOGO_URL, width: 120, height: 40 },
      name: "Example Co",
      altName: "Example Co",
      headerColor: "#0b1f3a",
      accentColor: "#1d4ed8",
      ...over,
    });
    const full = item({ body: "<p>Hi {{user.first_name}}</p>\n{{block.checklist}}\n{{block.insight}}\n{{block.next_step}}" });
    const button = (html: string) => html.match(/<td bgcolor="[^"]*"[^>]*><a [^>]*>/)?.[0] ?? "";

    it("no style (null or absent) is today's email", () => {
      const plain = renderLifecycleEmail({ item: full, values: values() });
      expect(renderLifecycleEmail({ item: full, values: values(), style: null })).toEqual(plain);
    });

    it("a branded email gets the band and the button colour — with a saved layout too", () => {
      const r = renderLifecycleEmail({ item: full, values: values(), style: style() });
      expect(r.html).toContain('bgcolor="#0b1f3a"');
      expect(r.html).toContain(`src="${LOGO_URL}"`);
      expect(button(r.html)).toContain('bgcolor="#1d4ed8"');
      // A dark accent is readable on white and on the panel, so links and the rule take it too.
      expect(r.html).toContain("color:#1d4ed8;text-decoration:underline");
      expect(r.html).toContain("border-left:3px solid #1d4ed8");
      expect(r.text).toBe(renderLifecycleEmail({ item: full, values: values() }).text);

      const layout = EmailLayoutSchema.parse({ blocks: [{ id: "b1", kind: "text", html: "<p>Hi {{user.first_name}}</p>" }] });
      expect(renderLifecycleEmail({ item: item({ layout }), values: values(), style: style() }).html).toContain('bgcolor="#0b1f3a"');
    });

    it("the accent button always has a readable label", () => {
      const dark = button(renderLifecycleEmail({ item: full, values: values(), style: style() }).html);
      expect(dark).toContain("background:#1d4ed8");
      expect(dark).toContain("color:#ffffff");
      const light = button(renderLifecycleEmail({ item: full, values: values(), style: style({ accentColor: "#FFD400" }) }).html);
      expect(light).toContain('bgcolor="#ffd400"');
      expect(light).toContain("color:#000000");
    });

    it("a light accent keeps checklist links and the insight rule at #111", () => {
      const r = renderLifecycleEmail({ item: full, values: values(), style: style({ accentColor: "#ffd400" }) });
      expect(r.html).toContain("color:#111;text-decoration:underline");
      expect(r.html).toContain("border-left:3px solid #111");
      expect(r.html).not.toContain("color:#ffd400");
    });

    it("a letter is byte-identical with or without a style", () => {
      const letter = item({ ...full, format: "letter" });
      const plain = renderLifecycleEmail({ item: letter, values: values() });
      const styled = renderLifecycleEmail({ item: letter, values: values(), style: style() });
      expect(styled).toEqual(plain);
      expect(styled.html).not.toContain("color-scheme");
    });

    it("a {{…}} in the company name stays literal", () => {
      const r = renderLifecycleEmail({
        item: full,
        values: values(),
        style: style({ logo: null, name: "{{user.email}}", altName: "{{user.email}}" }),
      });
      expect(r.html).toContain(">{{user.email}}</span>");
      expect(r.html).not.toContain("alex@acme.test");
      expect(r.missing).toEqual([]);
    });

    it("puts the preheader before the band, and only once", () => {
      const r = renderLifecycleEmail({ item: full, values: values(), style: style() });
      const pre = r.html.indexOf("2 steps left");
      expect(pre).toBeGreaterThan(-1);
      expect(pre).toBeLessThan(r.html.indexOf('bgcolor="#0b1f3a"'));
      expect(r.html.match(/2 steps left/g)).toHaveLength(1);
    });
  });
});

describe("entities (the brand, workspace or project an email is about)", () => {
  it("names the one it's about, and falls back when there isn't one", () => {
    const one = renderLifecycleEmail({
      item: item({ subject: "Next for {{entity.name|your brand}}", body: "<p>Your {{entity.kind}} {{entity.name}}.</p>" }),
      values: values({ entity: { name: "Acme", kind: "brand" } }),
    });
    expect(one.subject).toBe("Next for Acme");
    expect(one.html).toContain("Your brand Acme.");
    const none = renderLifecycleEmail({ item: item({ subject: "Next for {{entity.name|your brand}}", body: "<p>{{entity.name}}</p>" }), values: values() });
    expect(none.subject).toBe("Next for your brand");
    expect(none.missing).toEqual(["entity.name"]); // no fallback: the runner won't send it
  });

  it("lists all of them in a digest, capped with “and N more”", () => {
    const r = renderLifecycleEmail({
      item: item({ body: "<p>You have {{entities.count}} brands.</p>\n{{block.entities}}" }),
      values: values({
        entities: {
          count: 3,
          rows: [
            { name: "Acme", done: 3, total: 3, facts: [{ label: "Share of voice", value: "12%" }] },
            { name: "Beta", done: 1, total: 3, facts: [] },
          ],
          more: 1,
        },
      }),
    });
    expect(r.missing).toEqual([]);
    expect(r.html).toContain("You have 3 brands.");
    expect(r.html).toContain("<strong>Acme</strong> — 3 of 3 steps done · Share of voice: 12%");
    expect(r.html).toContain("<strong>Beta</strong> — 1 of 3 steps done");
    expect(r.html).toContain("and 1 more");
    expect(renderLifecycleEmail({ item: item({ body: "<p>x</p>\n{{block.entities}}" }), values: values() }).missing).toEqual([]);
  });
});
