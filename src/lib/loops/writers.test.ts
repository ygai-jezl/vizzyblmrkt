import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schedulePost } from "@/lib/distribute/scheduler";
import { countSendUnrecorded, sendMetadata, upsertEarlierSend } from "@/lib/email/sends";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { CountBuffer } from "./count";
import { learnedFor } from "./read";
import { sumWeek } from "./testing/sumWeek";

/**
 * The writers of step 5 (learning loops step 5, 4.2 of the plan for steps 4 and 5): a scheduled
 * post keeps its node's stamp, an email's send record keeps the sender's, a record that can't be
 * written counts its stamp lost, and with LOOPS_ENABLED off every record is as before. Hearth
 * Bakery and its people are made up.
 */

const hearth: TenantContext = { tenantId: "ten_hearth", region: "eu", source: "system" };
const NOW = new Date("2027-01-15T10:00:00.000Z");
const WEEK = "2027-W02";
const FUTURE = "2099-01-01T09:00:00.000Z";
const POSTS = "campaign_scheduled_posts";
const long = {
  tenantId: hearth.tenantId,
  campaignId: "",
  journeyId: "lcj_saturday",
  nodeId: "email_1",
  signupId: "pu_maya",
  variantId: "control",
  recipientKind: "product_user",
  connectionId: "conn_1",
};

afterEach(() => vi.unstubAllEnvs());

const post = (made: Parameters<typeof schedulePost>[1]["made"]) => ({
  workspaceId: "ws_1",
  contentPlanId: "plan_1",
  nodeId: "n1",
  channel: "linkedin" as const,
  body: "Fresh sourdough at 8.",
  scheduledAt: FUTURE,
  made,
});

describe("with LOOPS_ENABLED off", () => {
  beforeEach(() => vi.stubEnv("EMAIL_SEND_RECORDS_ENABLED", "true"));

  it("writes every record exactly as before (decision 22)", async () => {
    const db = new FakeFirestore();
    const { stamp } = await learnedFor(hearth, "content_write");
    expect(stamp).toEqual({ unstamped: "loops_off" });
    const { post: p } = await schedulePost(hearth, post(stamp), db);
    expect(db.raw(POSTS, p.id)).not.toHaveProperty("made");
    const { metadata: meta } = await sendMetadata(hearth, long, "lifecycle", { db: db as unknown as FirestoreLike, made: stamp });
    expect(db.raw("email_sends", meta.s!)).not.toHaveProperty("made");
  });
});

describe("with LOOPS_ENABLED on", () => {
  beforeEach(() => {
    vi.stubEnv("LOOPS_ENABLED", "true");
    vi.stubEnv("EMAIL_SEND_RECORDS_ENABLED", "true");
  });

  it("keeps the node's stamp on the post, and refreshes it when the post is armed again", async () => {
    const db = new FakeFirestore();
    const { stamp } = await learnedFor(hearth, "content_write", { promptId: "content.fill" }, { now: NOW });
    const { post: p } = await schedulePost(hearth, post({ unstamped: "person_wrote" }), db);
    expect(db.raw(POSTS, p.id)).toMatchObject({ made: { unstamped: "person_wrote" } });
    await schedulePost(hearth, post(stamp), db);
    expect(db.raw(POSTS, p.id)).toMatchObject({ made: { made: "m1.content_write.0.n", kind: "content_write" } });
  });

  it("keeps the sender's stamp on a new send record and never in the metadata", async () => {
    const db = new FakeFirestore();
    const { stamp } = await learnedFor(hearth, "send_time", {}, { now: NOW });
    const { metadata: meta, unrecorded } = await sendMetadata(hearth, long, "lifecycle", { db: db as unknown as FirestoreLike, made: stamp });
    expect(unrecorded).toBeNull();
    expect(Object.keys(meta).sort()).toEqual(["s", "t"]);
    expect(db.raw("email_sends", meta.s!)).toMatchObject({ made: { made: "m1.send_time.0.n", kind: "send_time" } });
  });

  it("says a stamp is lost when its send record can't be written, for the run's buffer", async () => {
    const counted = new FakeFirestore();
    const broken = { collection: () => { throw new Error("down"); }, runTransaction: () => { throw new Error("down"); } } as unknown as FirestoreLike;
    const counts = new CountBuffer({ db: counted, now: NOW, random: () => 0 });
    const { stamp } = await learnedFor(hearth, "send_time", {}, { now: NOW });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent = await sendMetadata(hearth, long, "lifecycle", { db: broken, made: stamp });
    expect(sent).toEqual({ metadata: long, unrecorded: "stamp_lost" });
    // The sender counts it beside made, once the email went.
    await countSendUnrecorded(hearth, stamp, "send_time", { counts }, sent.unrecorded!);
    await counts.flush();
    expect(sumWeek(counted, hearth.tenantId, WEEK)).toEqual({ u: { send_time: { stamp_lost: 1 } } });
  });

  it("marks the webhook's record of an earlier email records_off", async () => {
    const db = new FakeFirestore();
    await upsertEarlierSend(
      hearth,
      "es_earlier_1",
      () => ({ engine: "earlier", campaignId: "", journeyId: "j1", nodeId: "n1", signupId: "pu_maya", variantId: "control", mandrillMessageId: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }),
      () => null,
      db as unknown as FirestoreLike,
    );
    expect(db.raw("email_sends", "es_earlier_1")).toMatchObject({ engine: "earlier", made: { unstamped: "records_off" } });
  });
});
