import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { loopWeekOf } from "./count";
import { LOOPS } from "./registry";
import { sumWeek } from "./testing/sumWeek";
import {
  brandLearnFacts,
  errorCode,
  LEARN_KINDS,
  LEARN_REASONS,
  learnLogEntry,
  memoryListLogEntry,
  onceTenant,
  writeLearnLog,
  type BrandLearnFacts,
} from "./learnLog";

/**
 * The loop_learn line (ADR-0021): one per Memory Bank learn tried or skipped, named fields only,
 * and the brand's plan read with no more than brand access reads.
 */

const ctx = { tenantId: "ten_A", region: "us" } as const;
const facts: BrandLearnFacts = { plan: "pro", granted: false, grantedOnly: false, region: "us", agentRegion: "us", editVizzy: true };
const brand = (over: Partial<Tenant> = {}) => ({ id: "ten_A", orgPlan: "pro", grantedFeatures: [], ...over }) as unknown as Tenant;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the reasons and kinds", () => {
  it("are the design's fixed list plus the person's own choice", () => {
    expect([...LEARN_REASONS]).toEqual([
      "switch",
      "paused",
      "floor",
      "budget",
      "full",
      "trust",
      "region",
      "plan",
      "not_configured",
      "error",
      "off_by_person",
    ]);
  });

  it("name kinds in the learning registry", () => {
    for (const kind of LEARN_KINDS) expect(LOOPS).toHaveProperty(kind);
  });
});

describe("learnLogEntry", () => {
  it("says what was learned and how, with the brand's facts", () => {
    expect(learnLogEntry("edit_mode", "ten_A", facts, { outcome: "learned", via: "learning_key" }, 3)).toEqual({
      severity: "INFO",
      message: "[loops] edit_mode learned",
      event: "loop_learn",
      kind: "edit_mode",
      outcome: "learned",
      reason: null,
      tenantId: "ten_A",
      plan: "pro",
      granted: false,
      grantedOnly: false,
      region: "us",
      agentRegion: "us",
      editVizzy: true,
      via: "learning_key",
      entries: 3,
    });
  });

  it("says why it skipped, and warns only on an error", () => {
    const skipped = learnLogEntry("content_write", "ten_A", { ...facts, editVizzy: undefined }, { outcome: "skipped", reason: "plan" });
    expect(skipped).toMatchObject({ severity: "INFO", message: "[loops] content_write skipped: plan", outcome: "skipped", reason: "plan" });
    expect(skipped).not.toHaveProperty("editVizzy");
    expect(skipped).not.toHaveProperty("via");
    const failed = learnLogEntry("edit_mode", "ten_A", facts, { outcome: "skipped", reason: "error", code: "memory_bank_404" });
    expect(failed).toMatchObject({ severity: "WARNING", reason: "error", code: "memory_bank_404" });
  });

  it("copies named fields only, so no text, person or address can reach a line", () => {
    const sneaky = {
      ...facts,
      userId: "u_secret",
      email: "someone@example.com",
      instruction: "make it punchier",
      memory: "Keeps intros short.",
    } as unknown as BrandLearnFacts;
    const entry = learnLogEntry("edit_mode", "ten_A", sneaky, { outcome: "skipped", reason: "error", code: "Failed for someone@example.com" }, 2);
    const line = JSON.stringify(entry);
    for (const bad of ["u_secret", "someone@example.com", "punchier", "Keeps intros", "Failed for"]) expect(line).not.toContain(bad);
    expect(entry.code).toBe("other");
    expect(Object.keys(entry).sort()).toEqual(
      ["agentRegion", "code", "editVizzy", "entries", "event", "grantedOnly", "granted", "kind", "message", "outcome", "plan", "reason", "region", "severity", "tenantId"].sort(),
    );
  });

  it("keeps a count only when it is a sensible whole number", () => {
    expect(learnLogEntry("edit_mode", "ten_A", facts, { outcome: "learned", via: "edit_vizzy" }, 2.5)).not.toHaveProperty("entries");
    expect(learnLogEntry("edit_mode", "ten_A", facts, { outcome: "learned", via: "edit_vizzy" }, -1)).not.toHaveProperty("entries");
    expect(learnLogEntry("edit_mode", "ten_A", facts, { outcome: "learned", via: "edit_vizzy" })).not.toHaveProperty("entries");
  });

  it("names the scope a loops learner learned for, and only a scope", () => {
    const { editVizzy: _drop, ...imageFacts } = facts;
    void _drop;
    expect(learnLogEntry("loop_learn", "ten_A", imageFacts, { outcome: "learned", via: "votes" }, 5, "image_style.natural_photo")).toMatchObject({
      message: "[loops] loop_learn learned",
      kind: "loop_learn",
      via: "votes",
      entries: 5,
      scope: "image_style.natural_photo",
    });
    expect(learnLogEntry("loop_learn", "ten_A", imageFacts, { outcome: "skipped", reason: "error", code: "deadline" }, undefined, "image_style.natural_photo")).toMatchObject({ severity: "WARNING", reason: "error", code: "deadline" });
    for (const bad of ["Natural Photo", "image_style.natural_photo/../x", "maya@example.com", "a".repeat(41)]) {
      expect(learnLogEntry("loop_learn", "ten_A", imageFacts, { outcome: "skipped", reason: "paused" }, undefined, bad)).not.toHaveProperty("scope");
    }
  });
});

describe("errorCode", () => {
  it("keeps the app's own codes and nothing else", () => {
    expect(errorCode(new Error("memory_bank_500"))).toBe("memory_bank_500");
    expect(errorCode(new Error("agent_runtime_no_access_token"))).toBe("agent_runtime_no_access_token");
    expect(errorCode(new Error("7 PERMISSION_DENIED: Missing or insufficient permissions."))).toBe("other");
    expect(errorCode(new Error("x".repeat(61)))).toBe("other");
    expect(errorCode({ message: "memory_bank_500" })).toBe("other");
    expect(errorCode(undefined)).toBe("other");
  });
});

describe("brandLearnFacts", () => {
  it("reads nothing with plans off and the key not held back", async () => {
    const load = vi.fn(async () => brand());
    expect(await brandLearnFacts(ctx, load)).toEqual({ plan: "plans_off", granted: null, grantedOnly: false, region: "us", agentRegion: "us" });
    expect(load).not.toHaveBeenCalled();
  });

  it("gives the plan and the grant once brand access reads the brand", async () => {
    vi.stubEnv("PLANS_ENABLED", "true");
    expect(await brandLearnFacts(ctx, async () => brand(), true)).toMatchObject({ plan: "pro", granted: false, editVizzy: true });
    expect(await brandLearnFacts(ctx, async () => brand({ orgPlan: undefined }))).toMatchObject({ plan: "none" });
    expect(await brandLearnFacts(ctx, async () => Promise.reject(new Error("down")))).toMatchObject({ plan: "none", granted: false });
    vi.stubEnv("PLANS_ENABLED", "");
    vi.stubEnv("GRANTED_ONLY_FEATURES", "competitors, edit_vizzy_learning");
    expect(await brandLearnFacts(ctx, async () => brand({ grantedFeatures: ["edit_vizzy_learning"] }))).toMatchObject({
      plan: "plans_off",
      granted: true,
      grantedOnly: true,
    });
  });

  it("names the agent's region from its location, and none for a location outside them", async () => {
    vi.stubEnv("ROOT_AGENT_LOCATION", "europe-west4");
    expect((await brandLearnFacts({ tenantId: "ten_B", region: "eu" }, async () => null)).agentRegion).toBe("eu");
    vi.stubEnv("ROOT_AGENT_LOCATION", "australia-southeast1");
    expect((await brandLearnFacts(ctx, async () => null)).agentRegion).toBeNull();
  });
});

describe("onceTenant", () => {
  it("reads the brand once however often it is asked, and survives a loader that throws", async () => {
    const load = vi.fn(async () => brand());
    const once = onceTenant(load);
    await Promise.all([once("ten_A"), once("ten_A"), once("ten_A")]);
    expect(load).toHaveBeenCalledTimes(1);
    const boom = onceTenant(() => {
      throw new Error("boom");
    });
    await expect(boom("ten_A")).rejects.toThrow("boom");
  });
});

describe("memoryListLogEntry", () => {
  it("names the bank's code, the brand and its regions, and nothing a person wrote", () => {
    vi.stubEnv("ROOT_AGENT_LOCATION", "us-central1");
    expect(memoryListLogEntry({ tenantId: "ten_A", region: "eu" }, new Error("memory_bank_503"))).toEqual({
      severity: "WARNING",
      message: "[loops] memory list failed: memory_bank_503",
      event: "memory_list_failed",
      tenantId: "ten_A",
      region: "eu",
      agentRegion: "us",
      code: "memory_bank_503",
    });
    const sneaky = { tenantId: "ten_A", region: "us", userId: "u1", email: "someone@example.com" } as never;
    const entry = memoryListLogEntry(sneaky, new Error("refused for someone@example.com"));
    expect(entry.code).toBe("other");
    expect(JSON.stringify(entry)).not.toMatch(/u1|someone@example\.com|refused/);
  });
});

describe("writeLearnLog", () => {
  it("writes one JSON line, a warning only for an error", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    writeLearnLog(learnLogEntry("edit_mode", "ten_A", facts, { outcome: "skipped", reason: "plan" }));
    writeLearnLog(learnLogEntry("edit_mode", "ten_A", facts, { outcome: "skipped", reason: "error", code: "memory_bank_500" }));
    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(info.mock.calls[0]![0]))).toMatchObject({ event: "loop_learn", reason: "plan" });
    expect(JSON.parse(String(warn.mock.calls[0]![0]))).toMatchObject({ severity: "WARNING", code: "memory_bank_500" });
  });
});

describe("writeLearnLog counts the Memory Bank's outcomes (learning loops step 5, 4.4)", () => {
  const NOW = new Date("2027-01-15T10:00:00.000Z");
  const untouchable = new Proxy({}, { get: (_t, p) => { throw new Error(`a count touched the database (${String(p)})`); } }) as FirestoreLike;

  it("adds learned, or the reason it skipped, per kind in the brand's week with LOOPS_ENABLED on", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("LOOPS_ENABLED", "true");
    const db = new FakeFirestore();
    const deps = { db, now: NOW, random: () => 0 };
    await writeLearnLog(learnLogEntry("edit_mode", "ten_A", facts, { outcome: "learned", via: "edit_vizzy" }, 3), deps);
    await writeLearnLog(learnLogEntry("edit_mode", "ten_A", facts, { outcome: "skipped", reason: "plan" }), deps);
    await writeLearnLog(learnLogEntry("content_write", "ten_A", facts, { outcome: "skipped", reason: "off_by_person" }, 1), deps);
    // The loops' own learners count their outcomes themselves, and a memory list line is no learn.
    await writeLearnLog(learnLogEntry("loop_learn", "ten_A", facts, { outcome: "learned", via: "votes" }, 1, "image_style.brand"), { db: untouchable });
    await writeLearnLog(memoryListLogEntry(ctx, new Error("memory_bank_403")), { db: untouchable });
    // The post patterns judge's deferral is a line only (step 5, 4.9).
    await writeLearnLog(learnLogEntry("post_feedback", "ten_A", facts, { outcome: "skipped", reason: "error", code: "judge_unsafe" }, undefined, "linkedin"), { db: untouchable });
    expect(sumWeek(db, "ten_A", loopWeekOf(NOW))).toEqual({ r: { edit_mode: { learned: 1, plan: 1 }, content_write: { off_by_person: 1 } } });
  });

  it("counts nothing with LOOPS_ENABLED off, and never fails the line", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await writeLearnLog(learnLogEntry("edit_mode", "ten_A", facts, { outcome: "skipped", reason: "plan" }), { db: untouchable });
    vi.stubEnv("LOOPS_ENABLED", "true");
    const broken = { collection: () => { throw new Error("down"); }, runTransaction: () => { throw new Error("down"); } } as unknown as FirestoreLike;
    await expect(writeLearnLog(learnLogEntry("edit_mode", "ten_A", facts, { outcome: "skipped", reason: "plan" }), { db: broken, now: NOW })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
