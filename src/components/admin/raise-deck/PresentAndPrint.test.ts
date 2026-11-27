import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PRINT_SLIDE_CLASS } from "@/lib/raise/docs/print";
import { NOW, preSeedSlides } from "@/lib/raise/docs/testing/fixtures";
import { THEME, fernhillView } from "@/lib/raise/docs/testing/view";
import { PDF_WORDS, PRESENT_WORDS, UK_PROMOTION_REMINDER } from "@/lib/raise/docs/words";
import { PresentView } from "./PresentView";
import { PrintSlides } from "./PrintDeck";
import { UkReminderDialog, beforeSaveLines } from "./UkReminderDialog";

const decode = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
const words = (html: string) => decode(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("Save as PDF", () => {
  const slides = preSeedSlides().map((s, i) => (i === 3 ? { ...s, needs: [{ id: "nd_aaaaaaaa", text: "a number that shows demand" }] } : s));
  const html = renderToStaticMarkup(
    createElement(PrintSlides, { slides, theme: THEME, title: "Acme pre-seed", audience: "investor", stage: "pre_seed", version: { n: 4, at: NOW.toISOString() }, now: NOW }),
  );

  it("gives a pre-seed deck 10 pages, one slide a page, with the print stylesheet", () => {
    expect(html.match(new RegExp(`class="${PRINT_SLIDE_CLASS}"`, "g"))).toHaveLength(10);
    expect(html).toContain("@page { size: 13.333in 7.5in; margin: 0; }");
  });

  it("keeps real text, the footer on the last page, and leaves Needs out", () => {
    const text = words(html);
    expect(text).toContain("Acme makes traction simple for small teams");
    expect(text).toContain("Version 4, 26 Nov");
    expect(text).not.toContain("Needs:");
  });
});

describe("Before you save", () => {
  it("reminds an investor deck of the UK rules, in the plan's words, with the Needs and how to save", () => {
    expect(beforeSaveLines("investor", 2)).toEqual([UK_PROMOTION_REMINDER, "2 slides still have Needs. Needs don't print.", PDF_WORDS.print]);
    const out = decode(renderToStaticMarkup(createElement(UkReminderDialog, { open: true, audience: "investor", needs: 1, onSave: () => undefined, onCancel: () => undefined })));
    expect(out).toContain(PDF_WORDS.title);
    expect(out).toContain(UK_PROMOTION_REMINDER);
    expect(out).toContain("1 slide still has Needs. Needs don't print.");
    expect(out).toContain(PDF_WORDS.save);
    expect(out).toContain(PDF_WORDS.cancel);
  });

  it("shows no reminder for a lender pack: a loan isn't an investment", () => {
    expect(beforeSaveLines("lender", 0)).toEqual([PDF_WORDS.print]);
    const out = decode(renderToStaticMarkup(createElement(UkReminderDialog, { open: true, audience: "lender", needs: 0, onSave: () => undefined, onCancel: () => undefined })));
    expect(out).not.toContain(UK_PROMOTION_REMINDER);
    expect(out).toContain(PDF_WORDS.print);
  });
});

describe("Present", () => {
  const fern = fernhillView();
  const present = (rehearse: boolean) =>
    words(
      renderToStaticMarkup(
        createElement(PresentView, {
          slides: fern.slides,
          theme: fern.theme,
          title: fern.title,
          audience: "lender",
          stage: "loan",
          version: null,
          perSlideSeconds: [20, 40, 0, 0, 0],
          start: 1,
          rehearse,
          onClose: () => undefined,
        }),
      ),
    );

  it("opens on the slide it was asked for, with the key hint and no timer until notes are on", () => {
    const out = present(false);
    expect(out).toContain("Slide 2 of 5");
    expect(out).toContain("Sales are steady through the year");
    expect(out).toContain(PRESENT_WORDS.hint);
    expect(out).not.toContain("This slide 0:00");
  });

  it("Rehearse starts with the notes and the timer", () => {
    const out = present(true);
    expect(out).toContain("This slide 0:00 of about 0:40");
    expect(out).toContain("Total 0:00 of about 1:45");
    expect(out).toContain(PRESENT_WORDS.noNotes);
    expect(out).toContain(PRESENT_WORDS.restart);
  });
});
