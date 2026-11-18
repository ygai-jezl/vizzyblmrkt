import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { addLearned, clearLearned, learnedLines, listLearned, removeLearned, type LearnedDeps } from "./learned";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const B: TenantContext = { tenantId: "ten_B", region: "us", source: "idtoken", userId: "u2", role: "admin" };

function deps(): LearnedDeps & { db: FakeFirestore; clock: { t: number } } {
  const clock = { t: Date.parse("2026-11-18T12:00:00.000Z") };
  return { db: new FakeFirestore(), now: () => new Date((clock.t += 1000)), clock };
}

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_NEXT_UP_ENABLED", "true");
  vi.stubEnv("CREATE_AUTOPILOT_LEARNING_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("the Learned list", () => {
  it("keeps what a person did, newest first, and who did it", async () => {
    const d = deps();
    await addLearned(A, { kind: "skipped_pick", text: "What does ChatGPT cost?", reason: "we don't cover OpenAI's prices", from: "person" }, d);
    await addLearned(A, { kind: "left_out", text: "How do you seduce a Gemini?", reason: "the star sign", from: "autopilot" }, d);
    const list = await listLearned(A, d);
    expect(list.map((e) => e.kind)).toEqual(["left_out", "skipped_pick"]);
    expect(list[1]).toMatchObject({ by: "u1", from: "person" });
    expect(list[0]).toMatchObject({ by: null, from: "autopilot" });
  });

  it("replaces the same thing learned again, and never shows another brand's", async () => {
    const d = deps();
    await addLearned(A, { kind: "skipped_pick", text: "What does ChatGPT cost?", reason: "old", from: "person" }, d);
    await addLearned(A, { kind: "skipped_pick", text: "  what does chatgpt COST ", reason: "new", from: "person" }, d);
    expect((await listLearned(A, d)).map((e) => e.reason)).toEqual(["new"]);
    expect(await listLearned(B, d)).toEqual([]);
    const [e] = await listLearned(A, d);
    expect(await removeLearned(B, e!.id, d)).toBe(false);
    expect(await removeLearned(A, e!.id, d)).toBe(true);
    expect(await listLearned(A, d)).toEqual([]);
  });

  it("clears the whole list for one brand only", async () => {
    const d = deps();
    await addLearned(A, { kind: "moved", text: "One", from: "person" }, d);
    await addLearned(B, { kind: "moved", text: "Two", from: "person" }, d);
    expect(await clearLearned(A, d)).toBe(1);
    expect(await forTenant(B, d.db).autopilotLearned.count()).toBe(1);
  });

  it("gives picking and the judge the closest lines first, and nothing with the switch off", async () => {
    const d = deps();
    await addLearned(A, { kind: "left_out", text: "How do you seduce a Gemini?", reason: "the star sign", from: "autopilot" }, d);
    await addLearned(A, { kind: "skipped_pick", text: "What does ChatGPT cost?", reason: "we don't cover OpenAI's prices", from: "person" }, d);
    const lines = await learnedLines(A, { text: "Can I talk to Gemini like a person?", limit: 5 }, d);
    expect(lines).toEqual([
      'Left out as not for this brand: "How do you seduce a Gemini?", the star sign',
      'Skipped as a next article: "What does ChatGPT cost?", because we don\'t cover OpenAI\'s prices',
    ]);
    vi.stubEnv("CREATE_AUTOPILOT_LEARNING_ENABLED", "false");
    expect(await learnedLines(A, {}, d)).toEqual([]);
  });

  it("ignores an empty entry", async () => {
    expect(await addLearned(A, { kind: "moved", text: "   ", from: "person" }, deps())).toBeNull();
  });
});
