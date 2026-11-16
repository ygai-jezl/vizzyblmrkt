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

const ctx: TenantContext = { tenantId: "ten_a", region: "us", source: "system" };
const AI = "Most onboarding emails are written once and then forgotten. Activation jumped 18% in one week. 🚀";
const POSTED = "Most onboarding emails are written once and never looked at again. Activation went up in a week.";

function deps(over: Partial<LearnDeps> = {}): LearnDeps & { learn: ReturnType<typeof vi.fn> } {
  return {
    learn: vi.fn(async () => undefined),
    canUse: vi.fn(async () => true),
    isOff: vi.fn(async () => false),
    configured: () => true,
    ...over,
  } as LearnDeps & { learn: ReturnType<typeof vi.fn> };
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
