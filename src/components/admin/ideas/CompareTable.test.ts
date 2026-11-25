import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import type { ComparedIdea } from "@/lib/ideas/compare";
import { CompareTable, sinceLine } from "./CompareTable";

const col = (over: Partial<ComparedIdea>): ComparedIdea => ({
  id: "team-spaces",
  name: "Team spaces",
  idea: {},
  archived: false,
  handedOffTo: null,
  funnel: { waitlisted: 0, verified: 0, invited: 0, signedUp: 0, activated: 0 },
  ...over,
});
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

describe("the compare table", () => {
  const html = renderToStaticMarkup(
    createElement(CompareTable, {
      columns: [
        col({ idea: { status: "testing", statusAt: "2026-11-18T10:00:00.000Z", hypothesis: "Teams pay." }, funnel: { waitlisted: 684, verified: 602, invited: 150, signedUp: 61, activated: 38 } }),
        col({ id: "weekly-digest", name: "Weekly digest email", idea: { status: "launched", statusAt: "2026-11-10T10:00:00.000Z" }, handedOffTo: "Lumen app" }),
      ],
    }),
  );

  it("has a row each for status, hypothesis, outcome and the five numbers, each against its own waitlist", () => {
    const t = text(html);
    for (const label of ["Status", "Hypothesis", "Outcome", "Waitlisted", "Verified", "Invited", "Signed up", "Activated"]) expect(t).toContain(label);
    expect(t).toContain("Since 18 Nov.");
    expect(t).toContain("Since 10 Nov. Handed off to Lumen app.");
    expect(t).toContain("88% of waitlisted");
    expect(t).toContain("25% of verified");
    expect(t).toContain("Nobody yet");
    expect(t).toContain("None yet.");
    expect(html).toContain('href="/admin/launches/weekly-digest"');
    expect(t).not.toMatch(/referr/i);
  });

  it("keeps house style", () => {
    expect(dashesIn(text(html))).toEqual([]);
    expect(aiTellsIn(text(html))).toEqual([]);
  });

  it("says when a launch has no status yet", () => {
    expect(sinceLine(col({}))).toBe("No status yet.");
  });
});
