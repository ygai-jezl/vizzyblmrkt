import { describe, it, expect } from "vitest";
import { SANDBOX_CATALOG } from "@/lib/connect/sandbox";
import { buildProductOnboardingDraft } from "./templates/productOnboarding";
import { planTimeline, type PlannedStep } from "./planner";
import { isInSendWindow, localDateKey, weekdayOfKey } from "./sendWindow";
import { validateLifecycleDraft } from "./graph";

const H = 3600_000;
const draft = buildProductOnboardingDraft(SANDBOX_CATALOG);
const policy = draft.settings.sendPolicy;
const ALL_STEPS = ["create_brand", "run_audit", "monitor_prompts"];

function plan(anchorIso: string, opts: { tz?: string; offsetMin?: number; doneAt?: number | null } = {}) {
  const anchorMs = Date.parse(anchorIso);
  const doneAt = opts.doneAt;
  return planTimeline(
    { graph: draft.graph, pools: draft.pools, policy },
    SANDBOX_CATALOG,
    {
      anchorMs,
      tz: opts.tz ?? "Europe/London",
      offsetMin: opts.offsetMin ?? 20,
      stepsDoneAt: doneAt == null ? {} : Object.fromEntries(ALL_STEPS.map((s) => [s, doneAt])),
    },
  );
}

const sends = (steps: PlannedStep[]) => steps.filter((s) => s.kind === "send");
const items = (steps: PlannedStep[]) => sends(steps).map((s) => s.itemId);

describe("the product onboarding template", () => {
  it("is a valid journey for a catalog with onboarding steps", () => {
    expect(validateLifecycleDraft(draft, SANDBOX_CATALOG)).toEqual({ ok: true, issues: [] });
  });

  it("nudges a user who never finishes onboarding: welcome, three reminders, last note", () => {
    const steps = plan("2026-09-21T09:00:00Z"); // Monday 10:00 London
    expect(items(steps)).toEqual(["w", "r1", "r2", "q", "l"]);
    expect(steps.at(-1)?.kind).toBe("complete");
  });

  it("switches to education — starting at E1 — once onboarding is done mid-sequence", () => {
    const anchor = Date.parse("2026-09-21T09:00:00Z");
    expect(items(plan("2026-09-21T09:00:00Z", { doneAt: anchor + 30 * H }))).toEqual(["w", "r1", "e1", "e2", "e4"]);
    expect(items(plan("2026-09-21T09:00:00Z", { doneAt: anchor + 1 * H }))).toEqual(["w", "e1", "e2", "e3", "e4"]);
  });

  it("sends the welcome ~15 minutes after sign-up, even at night", () => {
    const steps = plan("2026-09-25T22:00:00Z"); // Friday 23:00 London
    expect(sends(steps)[0]).toMatchObject({ itemId: "w", atMs: Date.parse("2026-09-25T22:15:00Z") });
  });

  it("keeps every later email in a weekday window, on a new local day, with ≥40h gaps (property sweep)", () => {
    const start = Date.parse("2026-10-19T00:00:00Z");
    for (const tz of ["Europe/London", "America/New_York", "Asia/Kolkata", "Australia/Sydney", "Africa/Cairo"]) {
      for (const offsetMin of [0, 45, 89]) {
        for (let a = start; a < start + 7 * 24 * H; a += 5 * H) {
          const s = sends(plan(new Date(a).toISOString(), { tz, offsetMin }));
          expect(s.map((x) => x.itemId)).toEqual(["w", "r1", "r2", "q", "l"]);
          expect(s[0]!.atMs - a).toBe(0.25 * H);
          for (const x of s.slice(1)) {
            expect(isInSendWindow(x.atMs, tz, policy, offsetMin)).toBe(true);
            expect([1, 2, 3, 4, 5]).toContain(weekdayOfKey(localDateKey(x.atMs, tz)));
          }
          expect(localDateKey(s[1]!.atMs, tz) > localDateKey(s[0]!.atMs, tz)).toBe(true);
          expect(s[1]!.atMs - s[0]!.atMs).toBeGreaterThanOrEqual(12 * H);
          for (let i = 2; i < s.length; i += 1) expect(s[i]!.atMs - s[i - 1]!.atMs).toBeGreaterThanOrEqual(40 * H);
          expect(s.at(-1)!.atMs - a).toBeLessThanOrEqual(policy.hardStopDays * 24 * H);
        }
      }
    }
  });

  it("stops at the hard stop", () => {
    const short = { ...draft, settings: { ...draft.settings, sendPolicy: { ...policy, hardStopDays: 4 } } };
    const steps = planTimeline(
      { graph: short.graph, pools: short.pools, policy: short.settings.sendPolicy },
      SANDBOX_CATALOG,
      { anchorMs: Date.parse("2026-09-21T09:00:00Z"), tz: "Europe/London", offsetMin: 20 },
    );
    expect(steps.at(-1)).toMatchObject({ kind: "exit", label: "Stopped: hard_stop" });
    expect(items(steps).length).toBeLessThan(5);
  });
});
