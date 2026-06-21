import { describe, it, expect } from "vitest";
import { promoteVariant } from "./abTest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { EmailEvent } from "@/lib/types/emailEvent";

const ctx: TenantContext = { tenantId: "t1", region: "us", source: "system" };

function seedJourney(db: FakeFirestore, status: "active" | "draft" = "active") {
  db.seed("journeys", "journey_c1", {
    tenantId: "t1",
    campaignId: "c1",
    status,
    graph: {
      nodes: [
        {
          id: "email1",
          type: "email",
          position: { x: 0, y: 0 },
          data: {
            subject: "Original",
            body: "original body",
            heroImageUrl: null,
            abTest: {
              enabled: true,
              status: "running",
              splitPercent: 50,
              variants: [{ variantId: "var_a", subject: "Winner", body: "winner body" }],
            },
          },
        },
      ],
      edges: [],
    },
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  });
}

function seedSends(db: FakeFirestore, variantId: string, count: number) {
  for (let i = 0; i < count; i++) {
    const id = `evt:${variantId}:${i}`;
    const e: EmailEvent = {
      id,
      tenantId: "t1",
      campaignId: "c1",
      journeyId: "journey_c1",
      nodeId: "email1",
      signupId: `s${variantId}${i}`,
      variantId,
      type: "send",
      ts: "2026-06-20T00:00:00.000Z",
      createdAt: "2026-06-20T00:00:00.000Z",
    };
    db.seed("email_events", id, e);
  }
}

describe("promoteVariant", () => {
  it("copies the winner into the base copy and ends the test", async () => {
    const db = new FakeFirestore();
    seedJourney(db);
    const res = await promoteVariant(ctx, "c1", "email1", "var_a", {}, db);
    expect(res.ok).toBe(true);

    const j = db.raw("journeys", "journey_c1")!;
    const node = (j.graph as { nodes: Array<Record<string, unknown>> }).nodes[0]!;
    const data = node.data as Record<string, unknown>;
    expect(data.subject).toBe("Winner");
    expect(data.body).toBe("winner body");
    const ab = data.abTest as Record<string, unknown>;
    expect(ab.status).toBe("promoted");
    expect(ab.enabled).toBe(false);
    expect(ab.winnerVariantId).toBe("var_a");
    // The live status is preserved.
    expect(j.status).toBe("active");
  });

  it("keeps the base copy when control wins", async () => {
    const db = new FakeFirestore();
    seedJourney(db);
    const res = await promoteVariant(ctx, "c1", "email1", "control", {}, db);
    expect(res.ok).toBe(true);
    const data = (db.raw("journeys", "journey_c1")!.graph as { nodes: Array<Record<string, unknown>> })
      .nodes[0]!.data as Record<string, unknown>;
    expect(data.subject).toBe("Original");
  });

  it("errors on an unknown variant", async () => {
    const db = new FakeFirestore();
    seedJourney(db);
    const res = await promoteVariant(ctx, "c1", "email1", "var_gone", {}, db);
    expect(res).toEqual({ ok: false, error: "variant_not_found" });
  });

  it("refuses to promote on too small a sample when requireMinSample is set", async () => {
    const db = new FakeFirestore();
    seedJourney(db);
    seedSends(db, "var_a", 10); // below the threshold
    const res = await promoteVariant(ctx, "c1", "email1", "var_a", { requireMinSample: 50 }, db);
    expect(res).toEqual({ ok: false, error: "insufficient_data" });
  });

  it("promotes once the sample clears the threshold", async () => {
    const db = new FakeFirestore();
    seedJourney(db);
    seedSends(db, "var_a", 60);
    const res = await promoteVariant(ctx, "c1", "email1", "var_a", { requireMinSample: 50 }, db);
    expect(res.ok).toBe(true);
  });

  it("errors when there is no running test", async () => {
    const db = new FakeFirestore();
    db.seed("journeys", "journey_c1", {
      tenantId: "t1",
      campaignId: "c1",
      status: "active",
      graph: {
        nodes: [
          { id: "email1", type: "email", position: { x: 0, y: 0 }, data: { subject: "x", body: "y" } },
        ],
        edges: [],
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
    const res = await promoteVariant(ctx, "c1", "email1", "var_a", {}, db);
    expect(res).toEqual({ ok: false, error: "no_ab_test" });
  });
});
