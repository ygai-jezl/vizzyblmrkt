import { describe, it, expect } from "vitest";
import { FOOTER_MARKER } from "@/lib/email/emailRender";
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
});
