import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { xCrcResponse, verifyXWebhookSignature, parseXActivity, MAX_EVENTS_PER_BATCH } from "./webhook";

const SECRET = "consumer-secret";
const NOW = "2026-07-03T00:00:00.000Z";

describe("xCrcResponse", () => {
  it("HMAC-SHA256s the crc_token with the consumer secret, base64, sha256-prefixed", () => {
    const expected = `sha256=${createHmac("sha256", SECRET).update("tok").digest("base64")}`;
    expect(xCrcResponse("tok", SECRET)).toEqual({ response_token: expected });
  });
});

describe("verifyXWebhookSignature", () => {
  const body = JSON.stringify({ for_user_id: "1" });
  const good = `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("base64")}`;

  it("accepts a correct signature", () => {
    expect(verifyXWebhookSignature(body, good, SECRET)).toBe(true);
  });
  it("rejects a tampered body, wrong secret, and missing header", () => {
    expect(verifyXWebhookSignature(body + "x", good, SECRET)).toBe(false);
    expect(verifyXWebhookSignature(body, good, "other-secret")).toBe(false);
    expect(verifyXWebhookSignature(body, null, SECRET)).toBe(false);
    expect(verifyXWebhookSignature(body, "sha256=deadbeef", SECRET)).toBe(false);
  });
});

describe("parseXActivity", () => {
  it("returns empty on non-JSON / empty body", () => {
    expect(parseXActivity("not json", NOW)).toEqual({ forUserId: null, events: [], truncated: false });
  });

  it("classifies a reply, quote, mention, and repost; links the target", () => {
    const body = JSON.stringify({
      for_user_id: "ME",
      tweet_create_events: [
        { id_str: "r1", text: "reply!", user: { id_str: "u1", screen_name: "a", name: "A" }, in_reply_to_status_id_str: "P1" },
        { id_str: "q1", text: "quoting", user: { id_str: "u2", screen_name: "b" }, is_quote_status: true, quoted_status_id_str: "P2" },
        { id_str: "m1", text: "hey @us", user: { id_str: "u3" } },
        { id_str: "rt1", user: { id_str: "u4" }, retweeted_status: { id_str: "P3" } },
      ],
    });
    const { forUserId, events } = parseXActivity(body, NOW);
    expect(forUserId).toBe("ME");
    expect(events).toEqual([
      { type: "reply", remoteId: "r1", actorId: "u1", actorHandle: "a", actorName: "A", targetRemoteId: "P1", text: "reply!", ts: NOW },
      { type: "quote", remoteId: "q1", actorId: "u2", actorHandle: "b", actorName: undefined, targetRemoteId: "P2", text: "quoting", ts: NOW },
      { type: "mention", remoteId: "m1", actorId: "u3", actorHandle: undefined, actorName: undefined, targetRemoteId: undefined, text: "hey @us", ts: NOW },
      { type: "repost", remoteId: "rt1", actorId: "u4", actorHandle: undefined, actorName: undefined, targetRemoteId: "P3", text: undefined, ts: NOW },
    ]);
  });

  it("drops the account's OWN tweets (authored by for_user_id)", () => {
    const body = JSON.stringify({
      for_user_id: "ME",
      tweet_create_events: [{ id_str: "own", user: { id_str: "ME" }, in_reply_to_status_id_str: "P1" }],
    });
    expect(parseXActivity(body, NOW).events).toEqual([]);
  });

  it("parses likes with an injective per-(tweet,user) dedupe id (length-prefixed)", () => {
    const body = JSON.stringify({
      for_user_id: "ME",
      favorite_events: [{ user: { id_str: "u5", screen_name: "e" }, favorited_status: { id_str: "P9" } }],
    });
    expect(parseXActivity(body, NOW).events).toEqual([
      // pairKey("P9","u5") = `${"P9".length}:P9:u5` = "2:P9:u5"
      { type: "like", remoteId: "2:P9:u5", actorId: "u5", actorHandle: "e", actorName: undefined, targetRemoteId: "P9", ts: NOW },
    ]);
  });

  it("caps a hostile oversized batch at MAX_EVENTS_PER_BATCH and flags truncated", () => {
    const follow_events = Array.from({ length: MAX_EVENTS_PER_BATCH + 50 }, (_, i) => ({
      type: "follow",
      source: { id: `u${i}` },
    }));
    const { events, truncated } = parseXActivity(JSON.stringify({ for_user_id: "ME", follow_events }), NOW);
    expect(events).toHaveLength(MAX_EVENTS_PER_BATCH);
    expect(truncated).toBe(true);
  });

  it("does not read Object.prototype for a __proto__ DM sender", () => {
    const body = JSON.stringify({
      for_user_id: "ME",
      direct_message_events: [
        { type: "message_create", id: "d1", message_create: { sender_id: "__proto__", message_data: { text: "hi" } } },
      ],
      users: {},
    });
    const ev = parseXActivity(body, NOW).events[0]!;
    expect(ev).toMatchObject({ type: "dm", actorId: "__proto__", actorHandle: undefined, actorName: undefined });
  });

  it("parses follows (one per actor) and drops self-follows", () => {
    const body = JSON.stringify({
      for_user_id: "ME",
      follow_events: [
        { type: "follow", source: { id: "u6", screen_name: "f" }, target: { id: "ME" } },
        { type: "follow", source: { id: "ME" }, target: { id: "u6" } },
      ],
    });
    expect(parseXActivity(body, NOW).events).toEqual([
      { type: "follow", remoteId: "u6", actorId: "u6", actorHandle: "f", actorName: undefined, ts: NOW },
    ]);
  });

  it("parses inbound DMs, resolves the sender from users{}, drops DMs we sent", () => {
    const body = JSON.stringify({
      for_user_id: "ME",
      direct_message_events: [
        { type: "message_create", id: "d1", message_create: { sender_id: "u7", message_data: { text: "hi" } } },
        { type: "message_create", id: "d2", message_create: { sender_id: "ME", message_data: { text: "reply from us" } } },
      ],
      users: { u7: { id: "u7", screen_name: "g", name: "G" } },
    });
    expect(parseXActivity(body, NOW).events).toEqual([
      { type: "dm", remoteId: "d1", actorId: "u7", actorHandle: "g", actorName: "G", text: "hi", ts: NOW },
    ]);
  });

  it("converts timestamp_ms to ISO when present", () => {
    const body = JSON.stringify({
      for_user_id: "ME",
      favorite_events: [{ user: { id_str: "u8" }, favorited_status: { id_str: "P" }, timestamp_ms: "1751500800000" }],
    });
    expect(parseXActivity(body, NOW).events[0]!.ts).toBe(new Date(1751500800000).toISOString());
  });
});
