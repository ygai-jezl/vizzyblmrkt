import { describe, it, expect } from "vitest";
import type { ConnectionCatalog } from "@/lib/types/productConnection";
import { LifecycleSettingsSchema } from "@/lib/types/lifecycle";
import { buildProductOnboardingDraft } from "./templates/productOnboarding";
import { buildFollowOnDraft, waitOfDays } from "./templates/followOn";
import { validateLifecycleDraft } from "./graph";
import { planTimeline } from "./planner";
import { completionMs, dayNumber, journeyTimeline, timelineText } from "./timeline";

const catalog: ConnectionCatalog = {
  events: [],
  traits: [],
  onboardingSteps: [
    { id: "create_brand", label: "Add your brand", url: "https://app.example.com/brand", order: 0 },
    { id: "run_audit", label: "Run an audit", url: null, order: 1 },
  ],
  facts: [],
  glossary: [],
  entityKinds: [],
};
const TZ = "Europe/London";

describe("journeyTimeline", () => {
  it("reads the 7-day onboarding as it really runs: five emails, longer when a weekend falls inside it", () => {
    const t = journeyTimeline(buildProductOnboardingDraft(catalog), catalog, { timezone: TZ });
    expect(t.emails).toBe(5);
    // Someone who starts on a Monday: the welcome that day, then Tuesday, Thursday, and (over the weekend) Monday and Wednesday.
    expect(t.steps.map((s) => s.day)).toEqual([1, 2, 4, 8, 10]);
    expect(t.steps[0]!.label).toBe("W · Welcome");
    expect(t.days.min).toBeGreaterThanOrEqual(7);
    expect(t.days.max).toBeLessThanOrEqual(11);
    expect(t.days.typical).toBeGreaterThanOrEqual(t.days.min);
    expect(t.days.typical).toBeLessThanOrEqual(t.days.max);
    expect(t).toMatchObject({ sendDays: [1, 2, 3, 4, 5], sendTime: "09:00" });
    expect(timelineText(t)).toMatch(/^5 emails over about \d+ days \(\d+–\d+, depending on the day they start\)$/);
  });

  it("an any-time journey has no send days, and an empty one says so", () => {
    const base = buildProductOnboardingDraft(catalog);
    const anytime = { ...base, settings: { ...base.settings, sendPolicy: { ...base.settings.sendPolicy, anytime: true } } };
    expect(journeyTimeline(anytime, catalog, { timezone: TZ })).toMatchObject({ sendDays: null, sendTime: null });
    const empty = { graph: { nodes: [], edges: [] }, pools: [], settings: LifecycleSettingsSchema.parse({}) };
    expect(timelineText(journeyTimeline(empty, catalog))).toBe("no emails yet");
  });

  it("counts days on the person's calendar", () => {
    const monday10 = Date.parse("2026-01-05T10:00:00Z");
    expect(dayNumber(monday10, monday10 + 3600_000, TZ)).toBe(1);
    expect(dayNumber(monday10, Date.parse("2026-01-06T09:00:00Z"), TZ)).toBe(2);
  });
});

describe("the follow-on template", () => {
  const first = buildProductOnboardingDraft(catalog);
  const draft = (options?: { emails?: number; gapDays?: number }) =>
    buildFollowOnDraft({ afterJourneyId: "lcj_first", from: { name: "Onboarding", settings: first.settings }, options });

  it("is valid, and lands each email on the day asked for when every day is a send day", () => {
    const d = draft({ emails: 3, gapDays: 2 });
    expect(validateLifecycleDraft(d, catalog, { upstream: "ok" })).toEqual({ ok: true, issues: [] });
    const everyDay = { ...d, settings: { ...d.settings, sendPolicy: { ...d.settings.sendPolicy, days: [0, 1, 2, 3, 4, 5, 6] } } };
    // Day 1 is the day they finish the journey before; emails 2, 4 and 6 days later.
    expect(journeyTimeline(everyDay, catalog, { timezone: TZ }).steps.map((s) => s.day)).toEqual([3, 5, 7]);
  });

  it("a wait of whole days slips a day once an email has gone out; a wait made for days doesn't", () => {
    const d = draft({ emails: 3, gapDays: 2 });
    const everyDay = { ...d.settings.sendPolicy, days: [0, 1, 2, 3, 4, 5, 6] };
    const start = Date.parse("2026-01-05T10:00:00Z");
    const days = (hours: number | null) => {
      const graph = {
        ...d.graph,
        nodes: d.graph.nodes.map((n) => (n.type === "wait" ? { ...n, data: { ...n.data, wait: hours === null ? waitOfDays(2) : { minHours: hours } } } : n)),
      };
      // Someone whose own minute in the window is 20 past: emails go out a moment after it.
      return planTimeline({ graph, pools: d.pools, policy: everyDay }, catalog, { anchorMs: start, tz: TZ, offsetMin: 20 })
        .filter((s) => s.kind === "send")
        .map((s) => dayNumber(start, s.atMs, TZ));
    };
    expect(days(null)).toEqual([3, 5, 7]);
    // 48 hours from 10:00 is past the 09:20 slot two days on, so each email waits for the next day's.
    expect(days(48)).toEqual([4, 7, 10]);
  });

  it("carries on the earlier journey's window, sender and category, and stops with room for weekends", () => {
    const from = { ...first.settings, sendPolicy: { ...first.settings.sendPolicy, days: [2, 4], startHour: 14 }, sender: { fromName: "Jez" } };
    const d = buildFollowOnDraft({ afterJourneyId: "lcj_first", from: { name: "Onboarding", settings: from } });
    expect(d.settings.sendPolicy).toMatchObject({ days: [2, 4], startHour: 14, hardStopDays: 21 });
    expect(d.settings.sender.fromName).toBe("Jez");
    expect(d.settings.entry.requireMarketingConsent).toBe(true);
    expect(d.pools[0]!.items.map((i) => i.id)).toEqual(["f1", "f2", "f3", "f4"]);
    expect(draft({ emails: 9 }).pools[0]!.items).toHaveLength(6);
  });

  it("only a walk that reaches the end hands anyone on", () => {
    const d = draft({ emails: 1, gapDays: 1 });
    const start = Date.parse("2026-01-05T10:00:00Z");
    const steps = planTimeline({ graph: d.graph, pools: d.pools, policy: d.settings.sendPolicy }, catalog, { anchorMs: start, tz: TZ, offsetMin: 0 });
    expect(completionMs(steps)).toBe(steps.at(-1)!.atMs);
    const stopped = planTimeline({ graph: d.graph, pools: d.pools, policy: { ...d.settings.sendPolicy, days: [0], hardStopDays: 1 } }, catalog, { anchorMs: start, tz: TZ, offsetMin: 0 });
    expect(stopped.at(-1)!.kind).toBe("exit");
    expect(completionMs(stopped)).toBeNull();
  });
});
