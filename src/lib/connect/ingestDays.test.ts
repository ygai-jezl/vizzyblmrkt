import { afterEach, describe, expect, it, vi } from "vitest";
import { forTenant } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { ProductConnection } from "@/lib/types/productConnection";
import { recordDiagnostics } from "./ingest";

const ctx = { tenantId: "ten_fernleaf", region: "us" as const, source: "system" as const };
const connection = { id: "pcn_1" } as ProductConnection;
const seen = () => ({
  observedEvents: new Map([["signed_up", 2], ["upgraded", 1]]),
  observedTraits: new Map<string, string>(),
  summary: { accepted: 3, rejected: [] } as never,
  now: "2026-11-18T10:00:00Z",
});

afterEach(() => vi.unstubAllEnvs());

describe("product events counted per day", () => {
  it("adds a batch's accepted events to the connection's day only with the switch on", async () => {
    const db = new FakeFirestore() as unknown as FirestoreLike;
    await recordDiagnostics(ctx, connection, seen(), db);
    expect(await forTenant(ctx, db).productEventDays.find({ limit: 10 })).toEqual([]);
    vi.stubEnv("PRODUCT_EVENT_DAYS_ENABLED", "true");
    await recordDiagnostics(ctx, connection, seen(), db);
    await recordDiagnostics(ctx, connection, seen(), db);
    const days = await forTenant(ctx, db).productEventDays.find({ limit: 10 });
    const total = (name: string) => days.reduce((n, d) => n + (d.counts[name] ?? 0), 0);
    expect(days.every((d) => d.day === "2026-11-18" && d.connectionId === "pcn_1")).toBe(true);
    expect(total("signed_up")).toBe(4);
    expect(total("upgraded")).toBe(2);
  });
});
