import { describe, expect, it } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import type { TenantContext } from "./types";
import { deletePerformanceExemplars, listApprovedExemplars, PERFORMANCE_EXEMPLARS } from "./exemplars";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken" };

const approved = (tenantId: string, channel: string, id: string) => ({
  tenantId,
  channel,
  text: `${tenantId} ${id}`,
  tags: ["piece:email"],
  metric: { name: "approved", value: 1 },
  sourcePostId: `approved:ws1:plan1:${id}`,
  createdAt: "2026-11-01T00:00:00.000Z",
});

describe("the approved examples in the exemplar store", () => {
  it("lists only this brand's approved rows on the channel asked for", async () => {
    const db = new FakeFirestore();
    db.seed(PERFORMANCE_EXEMPLARS, "pex:ten_A:approved:ws1:plan1:a", approved("ten_A", "newsletter", "a"));
    db.seed(PERFORMANCE_EXEMPLARS, "pex:ten_A:approved:ws1:plan1:b", approved("ten_A", "blog", "b"));
    db.seed(PERFORMANCE_EXEMPLARS, "pex:ten_B:approved:ws1:plan1:a", approved("ten_B", "newsletter", "a"));
    db.seed(PERFORMANCE_EXEMPLARS, "pex:ten_A:post:1", { ...approved("ten_A", "newsletter", "p"), metric: { name: "reward_x100", value: 90 } });
    const rows = await listApprovedExemplars(A, "newsletter", db);
    expect(rows.map((r) => r.id)).toEqual(["pex:ten_A:approved:ws1:plan1:a"]);
    expect(rows[0]).toMatchObject({ channel: "newsletter", text: "ten_A a", tags: ["piece:email"], sourcePostId: "approved:ws1:plan1:a" });
  });

  it("deletes only ids under this brand's own prefix", async () => {
    const db = new FakeFirestore();
    db.seed(PERFORMANCE_EXEMPLARS, "pex:ten_A:approved:ws1:plan1:a", approved("ten_A", "newsletter", "a"));
    db.seed(PERFORMANCE_EXEMPLARS, "pex:ten_B:approved:ws1:plan1:a", approved("ten_B", "newsletter", "a"));
    const n = await deletePerformanceExemplars(A, ["pex:ten_A:approved:ws1:plan1:a", "pex:ten_B:approved:ws1:plan1:a"], db);
    expect(n).toBe(1);
    expect(db.raw(PERFORMANCE_EXEMPLARS, "pex:ten_A:approved:ws1:plan1:a")).toBeUndefined();
    expect(db.raw(PERFORMANCE_EXEMPLARS, "pex:ten_B:approved:ws1:plan1:a")).toBeDefined();
  });
});
