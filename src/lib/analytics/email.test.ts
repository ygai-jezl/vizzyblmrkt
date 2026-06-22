import { describe, it, expect } from "vitest";
import {
  aggregateEvents,
  computeCards,
  computeEmailAnalytics,
  computeSequenceEmailBreakdown,
  type SequenceRow,
  type BroadcastRow,
} from "./email";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { EmailEvent } from "@/lib/types/emailEvent";

const ctx: TenantContext = { tenantId: "t1", region: "us", source: "system" };

function ev(over: Partial<EmailEvent>): EmailEvent {
  return {
    id: "x",
    tenantId: "t1",
    campaignId: "c1",
    journeyId: "journey_c1",
    nodeId: "email1",
    signupId: "s1",
    variantId: "control",
    type: "send",
    ts: "2026-06-20T00:00:00.000Z",
    createdAt: "2026-06-20T00:00:00.000Z",
    ...over,
  };
}

describe("aggregateEvents", () => {
  it("counts sends/opens/clicks and computes rates over delivered", () => {
    const counts = aggregateEvents([
      ev({ type: "send" }),
      ev({ type: "send" }),
      ev({ type: "send" }),
      ev({ type: "bounce" }), // reduces delivered
      ev({ type: "open" }),
      ev({ type: "click" }),
    ]);
    // 3 sends - 1 bounce → 2 delivered; 1 open, 1 click.
    expect(counts.sent).toBe(3);
    expect(counts.delivered).toBe(2);
    expect(counts.openRate).toBeCloseTo(0.5);
    expect(counts.clickRate).toBeCloseTo(0.5);
  });

  it("counts unsubscribes without reducing delivered", () => {
    const counts = aggregateEvents([
      ev({ type: "send" }),
      ev({ type: "send" }),
      ev({ type: "unsub" }),
      ev({ type: "unsub" }),
    ]);
    // unsub is post-delivery: 2 sends, 0 failed → 2 delivered, 2 unsubscribed.
    expect(counts.sent).toBe(2);
    expect(counts.delivered).toBe(2);
    expect(counts.unsubscribed).toBe(2);
  });

  it("yields zero rates with no delivered", () => {
    expect(aggregateEvents([]).openRate).toBe(0);
  });
});

describe("computeCards", () => {
  it("rolls sequences (counts) and broadcasts (rates) into launch KPIs", () => {
    const seq: SequenceRow = {
      kind: "sequence",
      id: "journey_c1",
      name: "seq",
      enrolled: 10,
      sent: 100,
      delivered: 90,
      opened: 45,
      clicked: 9,
      unsubscribed: 2,
      openRate: 0.5,
      clickRate: 0.1,
    };
    const bc: BroadcastRow = {
      kind: "broadcast",
      id: "b1",
      name: "bc",
      enrolled: 100,
      delivered: 100,
      openRate: 0.4,
      clickRate: 0.1,
      unsubscribed: 1,
      pending: false,
    };
    const cards = computeCards([seq], [bc]);
    expect(cards.sends).toBe(200); // 100 + 100
    expect(cards.deliveryRate).toBeCloseTo(190 / 200);
    // opens: 45 (seq) + 40 (0.4*100) = 85 over 190 delivered
    expect(cards.openRate).toBeCloseTo(85 / 190);
  });
});

describe("computeEmailAnalytics + breakdown (fake Firestore)", () => {
  function seedJourney(db: FakeFirestore) {
    db.seed("journeys", "journey_c1", {
      tenantId: "t1",
      campaignId: "c1",
      status: "active",
      graph: {
        nodes: [
          { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
          {
            id: "email1",
            type: "email",
            position: { x: 0, y: 0 },
            data: {
              subject: "Welcome",
              body: "hi",
              abTest: {
                enabled: true,
                status: "running",
                splitPercent: 50,
                variants: [{ variantId: "var_a", subject: "Welcome A", body: "hiA" }],
              },
            },
          },
        ],
        edges: [{ id: "e0", source: "trigger", target: "email1", sourceHandle: null }],
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
  }

  function seedEvents(db: FakeFirestore, events: Array<Partial<EmailEvent>>) {
    events.forEach((e, i) => {
      const full = ev({ ...e, id: `evt${i}` });
      db.seed("email_events", full.id, full);
    });
  }

  it("builds a sequence row + per-arm breakdown", async () => {
    const db = new FakeFirestore();
    seedJourney(db);
    seedEvents(db, [
      // control arm: 2 sends, 1 open
      { signupId: "s1", variantId: "control", type: "send" },
      { signupId: "s2", variantId: "control", type: "send" },
      { signupId: "s1", variantId: "control", type: "open" },
      // var_a arm: 2 sends, 2 opens
      { signupId: "s3", variantId: "var_a", type: "send" },
      { signupId: "s4", variantId: "var_a", type: "send" },
      { signupId: "s3", variantId: "var_a", type: "open" },
      { signupId: "s4", variantId: "var_a", type: "open" },
      // one unsubscribe per arm
      { signupId: "s2", variantId: "control", type: "unsub" },
      { signupId: "s4", variantId: "var_a", type: "unsub" },
    ]);

    const a = await computeEmailAnalytics(ctx, "c1", db);
    expect(a.sequences).toHaveLength(1);
    expect(a.sequences[0]!.enrolled).toBe(4); // s1..s4 distinct senders
    expect(a.sequences[0]!.sent).toBe(4);
    expect(a.sequences[0]!.unsubscribed).toBe(2); // one per arm

    const { nodes } = await computeSequenceEmailBreakdown(ctx, "journey_c1", db);
    const node = nodes.find((n) => n.nodeId === "email1")!;
    expect(node.abTest).toBe(true);
    expect(node.unsubscribed).toBe(2); // node-level sum across arms
    const control = node.arms.find((x) => x.variantId === "control")!;
    const varA = node.arms.find((x) => x.variantId === "var_a")!;
    expect(control.openRate).toBeCloseTo(0.5); // 1/2
    expect(varA.openRate).toBeCloseTo(1.0); // 2/2
    expect(control.unsubscribed).toBe(1);
    expect(varA.unsubscribed).toBe(1);
  });

  it("includes sent broadcasts as rows and marks unsynced stats pending", async () => {
    const db = new FakeFirestore();
    db.seed("broadcasts", "b1", {
      tenantId: "t1",
      campaignId: "c1",
      name: "Teaser",
      subject: "s",
      body: "b",
      status: "sent",
      stats: { emailsSent: 200, openRate: 0.3, clickRate: 0.05, unsubscribed: 4 },
      createdAt: "2026-06-10T00:00:00.000Z",
    });
    db.seed("broadcasts", "b2", {
      tenantId: "t1",
      campaignId: "c1",
      name: "No stats yet",
      subject: "s",
      body: "b",
      status: "sent",
      createdAt: "2026-06-11T00:00:00.000Z",
    });

    const a = await computeEmailAnalytics(ctx, "c1", db);
    expect(a.broadcasts).toHaveLength(2);
    const synced = a.broadcasts.find((b) => b.id === "b1")!;
    expect(synced.enrolled).toBe(200);
    expect(synced.openRate).toBeCloseTo(0.3);
    expect(synced.unsubscribed).toBe(4);
    const unsynced = a.broadcasts.find((b) => b.id === "b2")!;
    expect(unsynced.pending).toBe(true);
    expect(unsynced.unsubscribed).toBe(0); // no stats yet → defaults to 0
  });
});
