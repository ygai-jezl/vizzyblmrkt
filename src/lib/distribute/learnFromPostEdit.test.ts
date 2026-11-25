import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  learnFromPublishedPost,
  postEditEventText,
  postEditPreferencesFor,
  postLearningFor,
  postPreferencesSection,
  type LearnDeps,
} from "./learnFromPostEdit";
import type { TenantContext } from "@/lib/tenant/types";
import type { LearnLogEntry } from "@/lib/loops/learnLog";

const ctx: TenantContext = { tenantId: "ten_a", region: "us", source: "system" };
const AI = "Most onboarding emails are written once and then forgotten. Activation jumped 18% in one week. 🚀";
const POSTED = "Most onboarding emails are written once and never looked at again. Activation went up in a week.";

function deps(over: Partial<LearnDeps> = {}): LearnDeps & { learn: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn> } {
  return {
    learn: vi.fn(async () => undefined),
    canUse: vi.fn(async () => true),
    isOff: vi.fn(async () => false),
    configured: () => true,
    load: vi.fn(async () => null),
    log: vi.fn(),
    ...over,
  } as LearnDeps & { learn: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn> };
}

/** The loop_learn lines a call wrote, checked to carry no person and no words. */
function linesOf(d: { log: ReturnType<typeof vi.fn> }): LearnLogEntry[] {
  const lines = d.log.mock.calls.map((c) => c[0] as LearnLogEntry);
  for (const l of lines) {
    const raw = JSON.stringify(l);
    for (const secret of ["uid_1", "onboarding", "Activation", "forgotten", "Vizzy drafted"]) expect(raw).not.toContain(secret);
  }
  return lines;
}

function switchesOn(): void {
  vi.stubEnv("CONTENT_AI_DRAFT_KEPT_ENABLED", "true");
  vi.stubEnv("NEXT_PUBLIC_EDIT_MODE_VIZZY_ENABLED", "true");
  vi.stubEnv("EDIT_MODE_VIZZY_LEARNING_ENABLED", "true");
  vi.stubEnv("DISTRIBUTE_LEARN_FROM_EDITS_ENABLED", "true");
}

afterEach(() => vi.unstubAllEnvs());

describe("postEditEventText", () => {
  it("describes the changed words in the person's voice, never the whole post", () => {
    const line = postEditEventText("linkedin", AI, POSTED)!;
    expect(line).toMatch(/^Vizzy drafted a LinkedIn post for me\. Before posting it I /);
    expect(line).toContain('"then forgotten." to "never looked at again."');
    expect(line).not.toContain("Most onboarding emails");
    expect(line.endsWith("I posted my version.")).toBe(true);
  });

  it("is null when nothing but spacing changed", () => {
    expect(postEditEventText("x", "Ship it.", "  Ship it.\n")).toBeNull();
  });

  it("caps the changed words at 200 characters", () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    const line = postEditEventText("x", "Short draft.", long)!;
    const changed = line.slice(line.indexOf("Before posting it I ") + 20, line.indexOf(". I posted my version."));
    expect(changed.length).toBeLessThanOrEqual(200);
  });
});

describe("learnFromPublishedPost", () => {
  const published = { channel: "linkedin" as const, aiBody: AI, body: POSTED, scheduledBy: "uid_1" };

  it("does nothing with the switch off", async () => {
    const d = deps();
    expect(await learnFromPublishedPost(ctx, published, d)).toBe("off");
    expect(d.learn).not.toHaveBeenCalled();
  });

  describe("with the switches on", () => {
    beforeEach(switchesOn);

    it("sends one line under the scheduler's own scope", async () => {
      const d = deps();
      expect(await learnFromPublishedPost(ctx, published, d)).toBe("learned");
      expect(d.learn).toHaveBeenCalledTimes(1);
      const [scope, lines] = d.learn.mock.calls[0]!;
      expect(scope).toEqual({ tenantId: "ten_a", userId: "uid_1" });
      expect(lines).toEqual([postEditEventText("linkedin", AI, POSTED)]);
    });

    it("skips a post with no draft, no changes, no person, or another channel", async () => {
      const d = deps();
      expect(await learnFromPublishedPost(ctx, { ...published, aiBody: null }, d)).toBe("no_draft");
      expect(await learnFromPublishedPost(ctx, { ...published, body: AI }, d)).toBe("unchanged");
      expect(await learnFromPublishedPost(ctx, { ...published, scheduledBy: null }, d)).toBe("no_person");
      expect(await learnFromPublishedPost(ctx, { ...published, channel: "blog" }, d)).toBe("off");
      expect(d.learn).not.toHaveBeenCalled();
    });

    it("respects Memory Bank, the brand's access and the person's choice", async () => {
      expect(await learnFromPublishedPost(ctx, published, deps({ configured: () => false }))).toBe("not_configured");
      expect(await learnFromPublishedPost(ctx, published, deps({ canUse: async () => false }))).toBe("not_included");
      const isOff = vi.fn(async (c: TenantContext) => c.userId === "uid_1");
      expect(await learnFromPublishedPost(ctx, published, deps({ isOff }))).toBe("person_off");
      expect(isOff).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "ten_a", userId: "uid_1" }));
    });

    it("never throws when Memory Bank fails", async () => {
      const d = deps({ learn: vi.fn(async () => Promise.reject(new Error("memory_bank_500"))) });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      expect(await learnFromPublishedPost(ctx, published, d)).toBe("off");
      warn.mockRestore();
    });
  });
});

describe("learnFromPublishedPost's loop_learn line", () => {
  const published = { channel: "linkedin" as const, aiBody: AI, body: POSTED, scheduledBy: "uid_1" };

  it("logs the switch only for a post that had something to learn, and answers as before", async () => {
    const d = deps();
    expect(await learnFromPublishedPost(ctx, published, d)).toBe("off");
    expect(linesOf(d)).toEqual([expect.objectContaining({ kind: "content_write", outcome: "skipped", reason: "switch", entries: 1 })]);
    const quiet = deps();
    expect(await learnFromPublishedPost(ctx, { ...published, aiBody: null }, quiet)).toBe("off");
    expect(await learnFromPublishedPost(ctx, { ...published, body: AI }, quiet)).toBe("off");
    expect(await learnFromPublishedPost(ctx, { ...published, scheduledBy: null }, quiet)).toBe("off");
    expect(await learnFromPublishedPost(ctx, { ...published, channel: "blog" }, quiet)).toBe("off");
    expect(quiet.log).not.toHaveBeenCalled();
  });

  describe("with the switches on", () => {
    beforeEach(switchesOn);

    it("logs what it learned, naming the brand and never the person or the words", async () => {
      const d = deps();
      expect(await learnFromPublishedPost(ctx, published, d)).toBe("learned");
      expect(linesOf(d)).toEqual([
        {
          severity: "INFO",
          message: "[loops] content_write learned",
          event: "loop_learn",
          kind: "content_write",
          outcome: "learned",
          reason: null,
          tenantId: "ten_a",
          plan: "plans_off",
          granted: null,
          grantedOnly: false,
          region: "us",
          agentRegion: "us",
          via: "learning_key",
          entries: 1,
        },
      ]);
    });

    it("logs one line for each skip, with its reason", async () => {
      const cases: [Partial<LearnDeps>, string, string][] = [
        [{ configured: () => false }, "not_configured", "not_configured"],
        [{ canUse: async () => false }, "not_included", "plan"],
        [{ isOff: async () => true }, "person_off", "off_by_person"],
      ];
      for (const [over, outcome, reason] of cases) {
        const d = deps(over);
        expect(await learnFromPublishedPost(ctx, published, d)).toBe(outcome);
        expect(linesOf(d)).toEqual([expect.objectContaining({ outcome: "skipped", reason })]);
      }
    });

    it("logs nothing for a post with nothing to learn", async () => {
      const d = deps();
      await learnFromPublishedPost(ctx, { ...published, aiBody: null }, d);
      await learnFromPublishedPost(ctx, { ...published, body: AI }, d);
      await learnFromPublishedPost(ctx, { ...published, scheduledBy: null }, d);
      await learnFromPublishedPost(ctx, { ...published, channel: "blog" }, d);
      expect(d.log).not.toHaveBeenCalled();
    });

    it("logs Memory Bank failing as an error code, still answering off", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const d = deps({ learn: vi.fn(async () => Promise.reject(new Error("memory_bank_404"))) });
      expect(await learnFromPublishedPost(ctx, published, d)).toBe("off");
      expect(linesOf(d)).toEqual([expect.objectContaining({ severity: "WARNING", reason: "error", code: "memory_bank_404" })]);
      const odd = deps({ isOff: async () => Promise.reject(new Error("Missing member uid_1")) });
      expect(await learnFromPublishedPost(ctx, published, odd)).toBe("off");
      expect(linesOf(odd)).toEqual([expect.objectContaining({ reason: "error", code: "other" })]);
      warn.mockRestore();
    });

    it("reads the brand once for its access and its plan", async () => {
      vi.stubEnv("PLANS_ENABLED", "true");
      const load = vi.fn(async () => ({ id: "ten_a", orgPlan: "pro", grantedFeatures: [] }) as never);
      const d = deps({ load, canUse: async (c, l) => Boolean(await l?.(c.tenantId)) });
      expect(await learnFromPublishedPost(ctx, published, d)).toBe("learned");
      expect(linesOf(d)).toEqual([expect.objectContaining({ plan: "pro", granted: false })]);
      expect(load).toHaveBeenCalledTimes(1);
    });

    it("never fails a publish when the log itself fails", async () => {
      const d = deps({ log: vi.fn(() => { throw new Error("stdout closed"); }) });
      expect(await learnFromPublishedPost(ctx, published, d)).toBe("learned");
    });
  });
});

describe("postLearningFor", () => {
  const person: TenantContext = { ...ctx, userId: "uid_1" };

  it("is unavailable with the switch off or without a person", async () => {
    expect(await postLearningFor(person, deps())).toEqual({ available: false, on: false });
    switchesOn();
    expect(await postLearningFor(ctx, deps())).toEqual({ available: false, on: false });
  });

  it("is available and follows the person's choice when on", async () => {
    switchesOn();
    expect(await postLearningFor(person, deps())).toEqual({ available: true, on: true });
    expect(await postLearningFor(person, deps({ isOff: async () => true }))).toEqual({ available: true, on: false });
    expect(await postLearningFor(person, deps({ canUse: async () => false }))).toEqual({ available: false, on: false });
  });
});

describe("postEditPreferencesFor and postPreferencesSection", () => {
  it("reads preferences only for LinkedIn and X with the switches on", async () => {
    const read = vi.fn(async () => ["Cuts emoji."]);
    expect(await postEditPreferencesFor(ctx, "linkedin", read)).toEqual([]);
    switchesOn();
    expect(await postEditPreferencesFor(ctx, "blog", read)).toEqual([]);
    expect(await postEditPreferencesFor(ctx, "x", read)).toEqual(["Cuts emoji."]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("fences the preferences as guidance after the brand voice, and is empty without any", () => {
    const s = postPreferencesSection(["Cuts emoji.", " "]);
    expect(s).toContain("<edit_preferences>\n- Cuts emoji.\n</edit_preferences>");
    expect(s).toContain("never over them");
    expect(postPreferencesSection([])).toBe("");
  });
});
