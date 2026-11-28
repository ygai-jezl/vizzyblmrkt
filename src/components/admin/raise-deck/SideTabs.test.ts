import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { deckChecks } from "@/lib/raise/docs/checks";
import { NOW } from "@/lib/raise/docs/testing/fixtures";
import { acmeView } from "@/lib/raise/docs/testing/view";
import { CHECKS_TAB, GUIDANCE, STUDIO_WORDS } from "@/lib/raise/docs/words";
import { TabBody, type SideTab } from "./SideTabs";

const view = acmeView();
const body = (tab: SideTab, slideAt = 1, over: Partial<Parameters<typeof TabBody>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(TabBody, {
      tab,
      slide: view.slides[slideAt]!,
      audience: "investor",
      checks: deckChecks({ audience: "investor", slides: view.slides }),
      sources: view.sources,
      talk: { slide: { words: 9, seconds: 4 }, deck: { words: 300, seconds: 120 } },
      now: NOW,
      ...over,
    }),
  )
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');

describe("the tabs beside the slide", () => {
  it("This slide: what the section is for", () => {
    expect(body("slide")).toContain(GUIDANCE.problem);
  });

  it("Sources: each line the slide drew on with where it came from, then its numbers", () => {
    const out = body("sources");
    expect(out).toContain("From your website");
    expect(out).toContain('href="https://acme.example/about"');
    expect(out).toContain("Acme helps small shops count stock.");
    const chart = body("sources", 3);
    expect(chart).toContain("Seen by YouGrow, 26 Nov");
    expect(chart).toContain("Sign-ups to your launches: 4,310");
    expect(body("sources", 2)).toContain(STUDIO_WORDS.sourcesEmpty);
  });

  it("Checks: the slide's, then the whole deck's, and that they are hints", () => {
    const out = body("checks", 7);
    expect(out).toContain(CHECKS_TAB.line);
    const withNumber = body("checks", 7, { checks: [{ code: "number_no_source", slideId: view.slides[7]!.id, message: 'A number with no source: "1,000". Insert a number or type it as Typed by you.' }, { code: "missing_why_now", slideId: null, message: "No why now slide." }] });
    expect(withNumber).toContain('A number with no source: "1,000".');
    expect(withNumber).toContain(CHECKS_TAB.deck);
    expect(withNumber).toContain("No why now slide.");
    expect(body("checks", 1, { checks: [] })).toContain(CHECKS_TAB.empty);
  });

  it("Talk track: words and time for the slide and the deck, and Rehearse when it can open Present", () => {
    const out = body("talk", 1, { onRehearse: () => undefined });
    expect(out).toContain(STUDIO_WORDS.talkLine);
    expect(out).toContain("9 words, about 4 seconds");
    expect(out).toContain("300 words, about 2 minutes at 150 words a minute, our estimate.");
    expect(out).toContain(STUDIO_WORDS.rehearse);
    expect(body("talk")).not.toContain(STUDIO_WORDS.rehearse);
  });
});
