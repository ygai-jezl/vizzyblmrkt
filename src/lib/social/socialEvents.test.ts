import { describe, it, expect } from "vitest";
import { recordSocialEvent, socialEventId } from "./socialEvents";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { RecordSocialEventInput } from "./socialEvents";

const COLLECTION = "social_events";
const ctx: TenantContext = { tenantId: "ten_1", region: "us", source: "system" };

function evt(over: Partial<RecordSocialEventInput> = {}): RecordSocialEventInput {
  return {
    platform: "x",
    type: "reply",
    remoteId: "tweet_1",
    actorId: "user_9",
    actorHandle: "someone",
    text: "nice post",
    ts: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("recordSocialEvent", () => {
  it("records an event under the deterministic dedupe id", async () => {
    const db = new FakeFirestore();
    const r = await recordSocialEvent(ctx, evt(), db);
    expect(r).toBe("recorded");
    const id = socialEventId({ platform: "x", type: "reply", remoteId: "tweet_1" });
    expect(id).toBe("sev:x:reply:tweet_1");
    const raw = db.raw(COLLECTION, id)!;
    expect(raw).toMatchObject({ tenantId: "ten_1", actorId: "user_9", text: "nice post" });
  });

  it("collapses a replayed event to a single row (duplicate)", async () => {
    const db = new FakeFirestore();
    expect(await recordSocialEvent(ctx, evt(), db)).toBe("recorded");
    expect(await recordSocialEvent(ctx, evt({ text: "edited" }), db)).toBe("duplicate");
    expect(db.dump(COLLECTION)).toHaveLength(1); // still one row, original preserved
    expect(db.raw(COLLECTION, "sev:x:reply:tweet_1")!.text).toBe("nice post");
  });

  it("keeps distinct events (different type or remoteId) as separate rows", async () => {
    const db = new FakeFirestore();
    await recordSocialEvent(ctx, evt({ type: "reply", remoteId: "t1" }), db);
    await recordSocialEvent(ctx, evt({ type: "like", remoteId: "t1:user_9" }), db);
    await recordSocialEvent(ctx, evt({ type: "reply", remoteId: "t2" }), db);
    expect(db.dump(COLLECTION)).toHaveLength(3);
  });

  it("nulls optional fields left unset", async () => {
    const db = new FakeFirestore();
    await recordSocialEvent(
      ctx,
      { platform: "x", type: "follow", remoteId: "user_9", actorId: "user_9", ts: "t" },
      db,
    );
    const raw = db.raw(COLLECTION, "sev:x:follow:user_9")!;
    expect(raw.targetRemoteId).toBeNull();
    expect(raw.text).toBeNull();
    expect(raw.actorHandle).toBeNull();
  });
});
