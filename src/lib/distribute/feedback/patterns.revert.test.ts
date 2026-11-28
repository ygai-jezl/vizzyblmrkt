import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  setTenantLearnedChannelPatterns: vi.fn(async () => undefined),
}));
vi.mock("@/lib/tenant/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/registry")>()),
  getTenantById: vi.fn(async () => ({ id: "ten_lumen", learnedPostPatterns: { channelFragments: { linkedin: { activeVersion: 3, latestVersion: 3, sampleCount: 8 } } } })),
}));

import { appendPatternVersion } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { loopWeekOf } from "@/lib/loops/count";
import { sumWeek } from "@/lib/loops/testing/sumWeek";
import { revertToVersion } from "./patterns";

/** A person reverting a channel's learned patterns counts the version they turned away from as undone (learning loops step 5, 4.4). */

const ctx: TenantContext = { tenantId: "ten_lumen", region: "us", source: "idtoken", userId: "uid_priya", role: "admin" };

async function seeded() {
  const db = new FakeFirestore();
  await appendPatternVersion(
    ctx,
    { channel: "linkedin", version: 1, directive: "Open with a question.", perform: [], avoid: [], judgeRationale: "First.", evidence: [], championScore: null, createdBy: "auto", createdAt: "2026-11-01T10:00:00.000Z" },
    db,
  );
  return db;
}

afterEach(() => vi.unstubAllEnvs());

describe("revertToVersion", () => {
  it("counts undone against the version in use, in its channel", async () => {
    vi.stubEnv("LOOPS_ENABLED", "true");
    const db = await seeded();
    expect(await revertToVersion(ctx, "linkedin", 1, db)).toEqual({ ok: true });
    const week = sumWeek(db, ctx.tenantId, loopWeekOf(new Date())) as { c: Record<string, unknown> };
    expect(week.c).toEqual({ linkedin: { post_feedback: { v3: { learned: { undone: 1 } } } } });
  });

  it("counts nothing for a version that isn't there, or with LOOPS_ENABLED off", async () => {
    vi.stubEnv("LOOPS_ENABLED", "true");
    const db = await seeded();
    expect(await revertToVersion(ctx, "linkedin", 9, db)).toEqual({ ok: false, reason: "version_not_found" });
    vi.stubEnv("LOOPS_ENABLED", "");
    expect(await revertToVersion(ctx, "linkedin", 1, db)).toEqual({ ok: true });
    expect(db.dump("loop_days")).toEqual([]);
  });
});
