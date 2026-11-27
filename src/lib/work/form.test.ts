import { describe, expect, it } from "vitest";
import { VENDOR } from "@/lib/loops/registry";
import { MEANINGS } from "@/lib/metrics/meanings";
import { MeasureInputSchema, AddTaskBodySchema } from "./inputs";
import {
  blankCheck,
  blankMeasure,
  blankPart,
  blankTypedLink,
  checkInputOf,
  draftOfMeasure,
  freeLinkOf,
  logLineOf,
  meaningChoices,
  measureInputOf,
  measureProblems,
  PRODUCT_EVENT_DAYS,
  sameTypedLink,
  switchNameOf,
  thenFor,
  typedLinkOf,
  typedLinkWords,
  withMeaning,
  type MeasureDraft,
} from "./form";
import { PRODUCT_EVENT_MAX_DAYS } from "./validate";
import type { Measure } from "./types";

// The add page's and task page's forms as plain data, and the requests they make. Made-up Lumen and Fernhill.

const SET = { setBy: "uid_nina", setAt: "2026-11-20T09:00:00.000Z" };

describe("How we'll know it worked, as the picker holds it", () => {
  it("sends no measure, Done is the win, or a kind with its fields, each one the route's shape takes", () => {
    expect(measureInputOf(blankMeasure())).toBeNull();
    expect(measureInputOf({ ...blankMeasure(), kind: "done" })).toEqual({ kind: "done" });
    const used: MeasureDraft = { kind: "used", first: blankPart({ counts: "event", connectionId: "pc_lumen", event: "note_from_template", days: 14 }), then: blankPart({ kind: "moves", meaning: "conversions", word: "Sign ups", days: 60 }) };
    const sent = measureInputOf(used);
    expect(sent).toEqual({
      kind: "used",
      counts: { productEvent: { connectionId: "pc_lumen", event: "note_from_template" } },
      look: { days: 14 },
      then: { kind: "moves", meaning: "conversions", direction: "up", word: "Sign ups", look: { days: 60 } },
    });
    expect(MeasureInputSchema.safeParse(sent).success).toBe(true);
    const runs = measureInputOf({ kind: "runs_better", first: blankPart({ what: "crashes", lookBy: "outputs", outputs: 20 }), then: null });
    expect(runs).toEqual({ kind: "runs_better", what: "crashes", look: { outputs: 20 }, then: null });
    expect(MeasureInputSchema.safeParse(runs).success).toBe(true);
    // The brand's word goes only with conversions.
    expect(measureInputOf({ kind: "moves", first: blankPart({ kind: "moves", meaning: "openRate", word: "Orders" }), then: null })).toEqual({ kind: "moves", meaning: "openRate", direction: "up", look: { days: 14 }, then: null });
  });

  it("opens a kept measure as it was, so saving it unchanged sends the same measure", () => {
    const kept: Measure[] = [
      { kind: "used", counts: { none: "We only sell in the shop" }, look: { days: 7 }, ...SET, then: null },
      { kind: "moves", meaning: "conversions", direction: "up", word: "Orders", look: { days: 28 }, ...SET, then: { kind: "runs_better", what: "speed", look: { days: 60 } } },
      { kind: "runs_better", what: "errors", look: { outputs: 40 }, ...SET },
      { kind: "done", ...SET },
    ];
    for (const m of kept) {
      const sent = measureInputOf(draftOfMeasure(m)) as Record<string, unknown>;
      const { setBy: _a, setAt: _b, ...rest } = m as Record<string, unknown>;
      expect(sent, m.kind).toEqual({ ...rest, ...(m.kind === "done" ? {} : { then: rest.then ?? null }) });
    }
  });

  it("says in words what the route would refuse, before sending", () => {
    const event = { kind: "used" as const, first: blankPart({ counts: "event", connectionId: "", event: "Not an event", days: 120 }), then: null };
    expect(measureProblems(event)).toEqual([
      "Pick the connected product the event comes from.",
      "Type the event's name as your product sends it, such as note_created.",
      "A product event is counted over days, at most 90, because events are kept for 90 days.",
    ]);
    expect(measureProblems({ kind: "used", first: blankPart({ days: 30 }), then: blankPart({ kind: "moves", days: 30 }) })).toEqual(["The then looks later than the first measure."]);
    expect(measureProblems({ kind: "used", first: blankPart({ days: 0 }), then: null })).toEqual(["When to look is 1 to 365 days after it's done."]);
    expect(measureProblems({ kind: "done", first: blankPart({ days: 0 }), then: null })).toEqual([]);
  });

  it("starts a then with the other kind, looking later; and a meaning's direction from its better", () => {
    const d: MeasureDraft = { kind: "used", first: blankPart({ days: 14 }), then: null };
    expect(thenFor(d)).toMatchObject({ kind: "moves", days: 60 });
    expect(thenFor({ ...d, kind: "moves", first: blankPart({ kind: "moves", days: 90 }) })).toMatchObject({ kind: "used", days: 91 });
    expect(withMeaning(blankPart(), "draftWordsChanged").direction).toBe("down");
    expect(withMeaning(blankPart(), "clickRate").direction).toBe("up");
  });

  it("offers the result numbers to everyone, more to operators, and never a provider's number or a date", () => {
    const plain = meaningChoices({ operator: false });
    expect(plain).toEqual(expect.arrayContaining(["conversions", "openRate", "clickRate", "searchClicks", "engagementRate"]));
    expect(plain).not.toContain("declineShare");
    expect(meaningChoices({ operator: true })).toContain("declineShare");
    for (const k of meaningChoices({ operator: true })) {
      expect(VENDOR.test(k), k).toBe(false);
      expect(MEANINGS[k].unit, k).not.toBe("date");
    }
    expect(meaningChoices({ operator: false, current: "people" })).toContain("people");
  });

  it("looks at most as far back as product events are kept", () => {
    expect(PRODUCT_EVENT_DAYS).toBe(PRODUCT_EVENT_MAX_DAYS);
  });
});

describe("Connected to, as the form adds it", () => {
  it("makes each kind of link, or says what's missing", () => {
    expect(typedLinkOf({ ...blankTypedLink("pull_request", "github:Lumen-Example/notes-app"), number: "84" })).toEqual({ ok: true, link: { kind: "pull_request", provider: "github", repo: "Lumen-Example/notes-app", number: 84 } });
    expect(typedLinkOf({ ...blankTypedLink("pull_request", "github:Lumen-Example/notes-app"), number: "" })).toEqual({ ok: false, problem: "Type the pull request's number, like 84." });
    expect(typedLinkOf({ ...blankTypedLink("switch"), switchName: switchNameOf("shared notebooks enabled") })).toEqual({ ok: true, link: { kind: "switch", name: "SHARED_NOTEBOOKS_ENABLED" } });
    expect(typedLinkOf({ ...blankTypedLink("switch"), none: true, noneReason: "It ships to everyone" })).toEqual({ ok: true, link: { kind: "switch", none: "It ships to everyone" } });
    expect(typedLinkOf({ ...blankTypedLink("idea"), idea: "ten_fernhill:market-stall" })).toEqual({ ok: true, link: { kind: "idea", brandId: "ten_fernhill", ideaId: "market-stall" } });
    expect(typedLinkOf({ ...blankTypedLink("plan"), planTitle: "Market stall plan", planUrl: "https://docs.example.com/plan", planVersion: "2" })).toEqual({
      ok: true,
      link: { kind: "plan", url: "https://docs.example.com/plan", title: "Market stall plan", version: "2" },
    });
    expect(typedLinkOf({ ...blankTypedLink("loop_line"), loopKind: "vizzy_chat" })).toEqual({ ok: true, link: { kind: "loop_line", loopKind: "vizzy_chat" } });
    expect(typedLinkOf({ ...blankTypedLink("loop_line"), loopKind: "not_a_loop" })).toMatchObject({ ok: false });
  });

  it("refuses a plan that isn't https, has a user name or password in it, or has no title", () => {
    const plan = (planUrl: string, planTitle = "Plan") => typedLinkOf({ ...blankTypedLink("plan"), planTitle, planUrl });
    expect(plan("http://docs.example.com/plan")).toEqual({ ok: false, problem: "Use an https link to the page, with no user name or password in it." });
    expect(plan("https://sam:secret@docs.example.com/plan")).toMatchObject({ ok: false });
    expect(plan(`https://docs.example.com/${"a".repeat(2001)}`)).toMatchObject({ ok: false });
    expect(plan("https://docs.example.com/plan", "  ")).toEqual({ ok: false, problem: "Give the plan a title." });
  });

  it("finds the same link twice, and says what each link is", () => {
    const pr = { kind: "pull_request" as const, provider: "github" as const, repo: "Lumen-Example/Notes-App", number: 84 };
    expect(sameTypedLink(pr, { ...pr, repo: "lumen-example/notes-app" })).toBe(true);
    expect(sameTypedLink(pr, { ...pr, number: 85 })).toBe(false);
    expect(typedLinkWords(pr)).toEqual({ label: "#84 in Lumen-Example/Notes-App", where: "Pull request" });
    expect(typedLinkWords({ kind: "plan", url: "https://docs.example.com/p", title: "Shared notebooks plan", version: "2" })).toEqual({ label: "Shared notebooks plan", where: "Plan, version 2 · docs.example.com" });
  });

  it("keeps a pasted link only when it is a full web address", () => {
    expect(freeLinkOf(" https://chat.example.com/c/1 ", " How invites should work ")).toEqual({ ok: true, link: { url: "https://chat.example.com/c/1", label: "How invites should work" } });
    expect(freeLinkOf("chat.example.com", "")).toMatchObject({ ok: false });
  });
});

describe("a check, as the form sets it", () => {
  it("sends tomorrow, next week, two weeks or a picked day at 08:00 unless changed, or a task to wait for", () => {
    const today = "2026-11-25";
    expect(checkInputOf(blankCheck(), today)).toBeNull();
    expect(checkInputOf({ ...blankCheck(), kind: "date" }, today)).toEqual({ kind: "date", day: "2026-11-26" });
    expect(checkInputOf({ ...blankCheck(), kind: "date", pick: "week", note: "Look at the night's runs" }, today)).toEqual({ kind: "date", day: "2026-12-02", note: "Look at the night's runs" });
    expect(checkInputOf({ ...blankCheck(), kind: "date", pick: "two", time: "17:30" }, today)).toEqual({ kind: "date", day: "2026-12-09", time: "17:30" });
    expect(checkInputOf({ ...blankCheck(), kind: "date", pick: "pick", day: "" }, today)).toBeUndefined();
    expect(checkInputOf({ ...blankCheck(), kind: "after_task" }, today)).toBeUndefined();
    expect(checkInputOf({ ...blankCheck(), kind: "after_task", afterRef: 75 }, today)).toEqual({ kind: "after_task", ref: 75 });
  });

  it("makes a body the add route takes", () => {
    const body = { title: "Van insurance", status: "todo", stage: "set_up", mustHave: true, links: [], blockedBy: [9], typedLinks: [], check: checkInputOf({ ...blankCheck(), kind: "date" }, "2026-11-25"), measure: measureInputOf({ ...blankMeasure(), kind: "done" }), via: "work_page" };
    expect(AddTaskBodySchema.safeParse(body).success).toBe(true);
  });
});

describe("the Log box", () => {
  it("reads a line as the workstream and its note", () => {
    expect(logLineOf("Pricing page: copy done, check on mobile")).toEqual({ workstream: "Pricing page", note: "copy done, check on mobile" });
    expect(logLineOf("  Window display  ")).toEqual({ workstream: "Window display", note: "" });
    expect(logLineOf(":")).toBeNull();
    expect(logLineOf("   ")).toBeNull();
  });
});
