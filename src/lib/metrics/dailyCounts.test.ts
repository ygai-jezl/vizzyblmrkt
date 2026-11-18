import { describe, expect, it } from "vitest";
import { forTenant } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { FirestoreLike } from "@/lib/tenant/types";
import { countProductEvents, countWidgetView, EVENT_NAMES_MAX } from "./dailyCounts";

const A = { tenantId: "ten_fernleaf", region: "us" as const };
const B = { tenantId: "ten_other", region: "us" as const };
const NOW = Date.parse("2026-11-18T10:00:00Z");

describe("daily counts", () => {
  it("adds up a launch's widget views per day and shard, and never another brand's", async () => {
    const db = new FakeFirestore() as unknown as FirestoreLike;
    await countWidgetView(A, "spring", { db, nowMs: NOW, shard: 3 });
    await countWidgetView(A, "spring", { db, nowMs: NOW, shard: 3 });
    await countWidgetView(B, "spring", { db, nowMs: NOW, shard: 3 }).catch(() => undefined);
    const a = await forTenant({ ...A, source: "system" }, db).widgetViewDays.getById("wvd:spring:2026-11-18:3");
    expect(a).toMatchObject({ tenantId: "ten_fernleaf", campaignId: "spring", day: "2026-11-18", views: 2 });
    expect(await forTenant({ ...B, source: "system" }, db).widgetViewDays.getById("wvd:spring:2026-11-18:3")).toBeNull();
  });

  it("adds up a connection's product events by name, with a cap on names", async () => {
    const db = new FakeFirestore() as unknown as FirestoreLike;
    await countProductEvents(A, "pcn_1", { signed_up: 2, upgraded: 1 }, { db, nowMs: NOW, shard: 0 });
    await countProductEvents(A, "pcn_1", { signed_up: 1, zero: 0 }, { db, nowMs: NOW, shard: 0 });
    const day = await forTenant({ ...A, source: "system" }, db).productEventDays.getById("ped:pcn_1:2026-11-18:0");
    expect(day?.counts).toEqual({ signed_up: 3, upgraded: 1 });
    const many = Object.fromEntries(Array.from({ length: EVENT_NAMES_MAX + 3 }, (_, i) => [`e${i}`, 1]));
    await countProductEvents(A, "pcn_2", many, { db, nowMs: NOW, shard: 0 });
    const capped = await forTenant({ ...A, source: "system" }, db).productEventDays.getById("ped:pcn_2:2026-11-18:0");
    expect(Object.keys(capped!.counts)).toHaveLength(EVENT_NAMES_MAX + 1);
    expect(capped!.counts.other).toBe(3);
  });
});
