import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import type { Idea } from "@/lib/types/campaign";
import type { HandoffChoices } from "@/lib/ideas/handoff";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const { IdeaCard, handoffPick } = await import("./IdeaCard");
const { ideaDay, statusLine, whoDid } = await import("@/lib/ideas/words");
const { NewLaunchForm } = await import("../NewLaunchForm");

const NAMES = { usr_sam: "Sam Rivera" };
const card = (idea: Idea, canEdit = true) =>
  renderToStaticMarkup(createElement(IdeaCard, { campaignId: "team-spaces", idea, canEdit, archived: false, viewerId: "usr_admin", names: NAMES }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ").trim();

describe("the idea card", () => {
  it("lets an admin pick one of six statuses, write the hypothesis and outcome, and mark it Just a list", () => {
    const html = card({ status: "testing", statusAt: "2026-11-18T10:00:00.000Z", statusBy: "usr_admin", hypothesis: "Teams pay." });
    expect(html.match(/role="radio"/g)).toHaveLength(6);
    expect(html).toMatch(/aria-checked="true"[^>]*>Testing</);
    expect(text(html)).toContain("Set to Testing by you on 18 Nov.");
    expect(text(html)).toContain("10 of 500");
    expect(text(html)).toContain("0 of 2,000");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save</);
    expect(text(html)).toContain("Just a list");
  });

  it("shows no status for a launch nobody gave one, never Exploring", () => {
    const html = card({});
    expect(html).not.toContain('aria-checked="true"');
    expect(text(html)).toContain("No status yet.");
  });

  it("is read only for a member: a chip, the text or None yet, and nothing to press", () => {
    const html = card({ status: "parked", statusAt: "2026-10-02T10:00:00.000Z", statusBy: "usr_sam", hypothesis: "Same day delivery sells." }, false);
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain('role="radio"');
    expect(html).not.toContain(">Save<");
    expect(html).not.toContain('type="checkbox"');
    expect(text(html)).toContain("Set to Parked by Sam Rivera on 2 Oct.");
    expect(text(html)).toContain("Same day delivery sells.");
    expect(text(html)).toContain("None yet.");
  });

  it("is one line for Just a list, with Make it an idea for an admin only", () => {
    expect(text(card({ justAList: true, status: "testing" }))).toBe("Just a list: no hypothesis or status, and it's left out of comparisons. Make it an idea");
    expect(text(card({ justAList: true }, false))).not.toContain("Make it an idea");
  });

  it("keeps house style in every state", () => {
    for (const html of [card({}), card({ status: "killed", statusBy: "usr_gone", statusAt: "2025-03-01T00:00:00.000Z" }, false), card({ justAList: true })]) {
      expect(dashesIn(text(html))).toEqual([]);
      expect(aiTellsIn(text(html))).toEqual([]);
    }
  });
});

describe("who and when", () => {
  it("says you, a name, or Former team member, and the year only when it isn't this one", () => {
    expect(whoDid("usr_admin", "usr_admin", NAMES)).toBe("you");
    expect(whoDid("usr_sam", "usr_admin", NAMES)).toBe("Sam Rivera");
    expect(whoDid("usr_gone", "usr_admin", NAMES)).toBe("Former team member");
    expect(whoDid(null, "usr_admin", NAMES)).toBeNull();
    const now = new Date("2026-11-25T09:00:00.000Z");
    expect(ideaDay("2026-11-18T23:30:00.000Z", now)).toBe("18 Nov");
    expect(ideaDay("2025-11-18T10:00:00.000Z", now)).toBe("18 Nov 2025");
    expect(ideaDay(null, now)).toBe("");
    expect(statusLine({ status: "validated", statusBy: null, statusAt: null }, "usr_admin", NAMES)).toBe("Set to Validated.");
  });
});

describe("New launch's hypothesis", () => {
  it("shows only when the page says so (an admin, with ideas on)", () => {
    const on = renderToStaticMarkup(createElement(NewLaunchForm, { hypothesis: true }));
    expect(text(on)).toContain("Hypothesis (optional)");
    expect(text(on)).toContain("0 of 500");
    expect(on).toContain('maxLength="500"');
    expect(text(renderToStaticMarkup(createElement(NewLaunchForm, {})))).not.toContain("Hypothesis");
  });
});

describe("handing off to a product", () => {
  const choices: HandoffChoices = {
    options: [
      { id: "pcn_app", name: "Lumen app", label: "Lumen app (Production)" },
      { id: "pcn_sb", name: "Test app", label: "Test app (Sandbox)" },
    ],
    defaultId: "pcn_app",
    fromWave: true,
    names: { pcn_app: "Lumen app", pcn_sb: "Test app", pcn_old: "Old app" },
  };
  const render = (idea: Idea, over: { canEdit?: boolean; productLinks?: boolean; handoff?: HandoffChoices | null } = {}) =>
    renderToStaticMarkup(
      createElement(IdeaCard, {
        campaignId: "weekly-digest",
        idea,
        canEdit: over.canEdit ?? true,
        archived: false,
        viewerId: "usr_admin",
        names: NAMES,
        handoff: over.handoff === undefined ? choices : over.handoff,
        productLinks: over.productLinks ?? false,
      }),
    );

  it("offers a launched idea's products, the latest wave's picked first", () => {
    const html = render({ status: "launched" });
    expect(text(html)).toContain("Hand off to a product");
    expect(html).toMatch(/<option value="pcn_app" selected="">Lumen app \(Production\)<\/option>/);
    expect(html).toContain('<option value="pcn_sb">Test app (Sandbox)</option>');
    expect(text(html)).toContain("Picked first: Lumen app, where its latest invite wave went.");
  });

  it("says where it went and when, links to the product only while products are on, and can change while Launched", () => {
    const idea: Idea = { status: "launched", productConnectionId: "pcn_app", handedOffAt: "2026-11-04T10:00:00.000Z", handedOffBy: "usr_admin" };
    expect(text(render(idea))).toContain("Handed off to Lumen app on 4 Nov by you.");
    expect(render(idea)).not.toContain('href="/admin/products/pcn_app"');
    expect(render(idea, { productLinks: true })).toMatch(/href="\/admin\/products\/pcn_app"[^>]*>Open Lumen app</);
    expect(text(render(idea))).toContain("Pick another product to change it.");
  });

  it("keeps the line when the status moves on, with nothing to pick", () => {
    const html = render({ status: "validated", productConnectionId: "pcn_old", handedOffAt: "2026-11-04T10:00:00.000Z", handedOffBy: "usr_sam" }, { productLinks: true });
    expect(text(html)).toContain("Handed off to Old app on 4 Nov by Sam Rivera.");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("/admin/products/");
  });

  it("shows a member the line only, and nothing before Launched", () => {
    const idea: Idea = { status: "launched", productConnectionId: "pcn_app", handedOffAt: "2026-11-04T10:00:00.000Z", handedOffBy: "usr_sam" };
    expect(render(idea, { canEdit: false })).not.toContain("<select");
    expect(text(render(idea, { canEdit: false }))).toContain("Handed off to Lumen app on 4 Nov by Sam Rivera.");
    expect(text(render({ status: "testing" }))).not.toContain("Hand off");
  });

  it("can hand off again when the idea went to a product since revoked, which the picker doesn't list", () => {
    const idea: Idea = { status: "launched", productConnectionId: "pcn_old", handedOffAt: "2026-11-04T10:00:00.000Z", handedOffBy: "usr_admin" };
    const html = render(idea, { handoff: { ...choices, options: [choices.options[0]!] } });
    expect(text(html)).toContain("Handed off to Old app on 4 Nov by you.");
    expect(html).toMatch(/<option value="pcn_app" selected="">Lumen app \(Production\)<\/option>/);
    expect(html).toMatch(/<button[^>]*>Hand off</);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Hand off</);
  });

  it("picks from the options shown now: the admin's pick, then where it went, then the default, then the first", () => {
    expect(handoffPick(choices, "pcn_sb", "pcn_app")).toBe("pcn_sb");
    expect(handoffPick(choices, null, "pcn_app")).toBe("pcn_app");
    // A revoked product, or nothing picked yet (options that came after Make it an idea): the default.
    expect(handoffPick(choices, null, "pcn_old")).toBe("pcn_app");
    expect(handoffPick(choices, null, undefined)).toBe("pcn_app");
    expect(handoffPick({ ...choices, defaultId: "pcn_old" }, null, null)).toBe("pcn_app");
    expect(handoffPick({ ...choices, defaultId: null, options: [choices.options[1]!] }, "pcn_app", null)).toBe("pcn_sb");
    expect(handoffPick(null, "pcn_app", "pcn_app")).toBe("");
  });

  it("points at Connect your product when there's nothing to hand off to", () => {
    const html = render({ status: "launched" }, { handoff: { options: [], defaultId: null, fromWave: false, names: {} } });
    expect(text(html)).toContain("No product is connected yet. See Connect your product .");
    expect(html).toContain('href="/help/connect-your-product"');
  });
});
