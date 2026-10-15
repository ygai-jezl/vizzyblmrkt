import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { RUN_STEPS, startRun, takeStep } from "./runs";

const ctx = (tenantId: string): TenantContext => ({ tenantId, region: "us", source: "idtoken", userId: "u1", role: "admin" });
const NOW = Date.parse("2026-10-15T10:00:00.000Z");

describe("a research run", () => {
  it("uses one research allowance, then its steps carry its id", async () => {
    const db = new FakeFirestore();
    const a = ctx("ten_run1");
    const run = await startRun(a, "groups", { db, nowMs: NOW });
    expect(run).toMatchObject({ ok: true, value: { kind: "groups", stepsLeft: RUN_STEPS.groups, startedBy: "u1" } });
    const id = run.ok ? run.value.id : "";
    // Many steps, none of them counted against the allowance.
    for (let i = 0; i < 5; i += 1) expect(await takeStep(a, id, "groups", { db, nowMs: NOW })).toMatchObject({ ok: true });
    expect(await takeStep(a, id, "groups", { db, nowMs: NOW })).toEqual({ ok: true, value: { stepsLeft: RUN_STEPS.groups - 6 } });
    // Starting runs is research's allowance: two a minute.
    expect((await startRun(a, "groups", { db, nowMs: NOW })).ok).toBe(true);
    expect(await startRun(a, "groups", { db, nowMs: NOW })).toEqual({ ok: false, status: 429, error: "rate_limited" });
  });

  it("refuses a step from another brand, for another kind, after it ends, or past its steps", async () => {
    const db = new FakeFirestore();
    const a = ctx("ten_run2");
    const run = await startRun(a, "groups", { db, nowMs: NOW });
    const id = run.ok ? run.value.id : "";
    expect(await takeStep(ctx("ten_other"), id, "groups", { db, nowMs: NOW })).toMatchObject({ ok: false, status: 404, error: "no_run" });
    expect(await takeStep(a, id, "situations", { db, nowMs: NOW })).toEqual({ ok: false, status: 400, error: "wrong_run" });
    expect(await takeStep(a, id, "groups", { db, nowMs: NOW + 31 * 60_000 })).toEqual({ ok: false, status: 410, error: "run_expired" });
    for (let i = 0; i < RUN_STEPS.groups; i += 1) await takeStep(a, id, "groups", { db, nowMs: NOW });
    expect(await takeStep(a, id, "groups", { db, nowMs: NOW })).toEqual({ ok: false, status: 429, error: "run_used_up" });
  });
});
