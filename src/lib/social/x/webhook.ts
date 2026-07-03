import { createHmac, timingSafeEqual } from "node:crypto";
import type { SocialEventType } from "@/lib/types/socialEvent";

/**
 * X Account Activity API webhook plumbing — CRC challenge + signature verification
 * + payload parsing. Pure and fully unit-testable (no network, no Firestore).
 *
 * AUTH: X signs each POST with HMAC-SHA256 over the raw body, keyed by the app's
 * OAuth consumer SECRET, and sends it base64 in `x-twitter-webhooks-signature` as
 * `sha256=<b64>`. Registration/health is a GET carrying a `crc_token` we must echo
 * back HMAC'd the same way. Both use the consumer secret — never a user token.
 *
 * Account Activity is an ENTERPRISE-tier product; this is built flag-/provisioning-
 * gated (like publishing) and stays dormant until X access is provisioned.
 */

/** Build the CRC challenge response body for X's registration GET. */
export function xCrcResponse(crcToken: string, consumerSecret: string): { response_token: string } {
  const mac = createHmac("sha256", consumerSecret).update(crcToken).digest("base64");
  return { response_token: `sha256=${mac}` };
}

/** Verify the `x-twitter-webhooks-signature` header over the raw POST body. */
export function verifyXWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  consumerSecret: string,
): boolean {
  if (!signatureHeader || !consumerSecret) return false;
  const expected = `sha256=${createHmac("sha256", consumerSecret).update(rawBody, "utf8").digest("base64")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** A platform-agnostic engagement event, ready for recordSocialEvent (platform="x"). */
export interface ParsedXEvent {
  type: SocialEventType;
  remoteId: string;
  actorId: string;
  actorHandle?: string;
  actorName?: string;
  targetRemoteId?: string;
  text?: string;
  ts: string;
}

export interface ParsedXActivity {
  /** The subscribed account the events are FOR — used to attribute to a tenant. */
  forUserId: string | null;
  events: ParsedXEvent[];
  /** True if the batch was capped at MAX_EVENTS_PER_BATCH (DoS guard). */
  truncated: boolean;
}

/** Hard ceiling on events processed from one delivery (write-amplification guard).
 *  Real Account Activity deliveries are tiny; this only bites a hostile payload. */
export const MAX_EVENTS_PER_BATCH = 500;

/** Injective 2-part key for events with no id of their own (likes/quotes): a
 *  length prefix pins where the first component ends, so no `:` collision is
 *  possible even for non-numeric ids (X ids are numeric, but this is reused). */
function pairKey(a: string, b: string): string {
  return `${a.length}:${a}:${b}`;
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** ms-epoch string / created_at → ISO, else a caller-supplied fallback. */
function tsOf(o: Obj, fallback: string): string {
  const ms = o.timestamp_ms ?? o.created_timestamp;
  if (typeof ms === "string" && /^\d+$/.test(ms)) return new Date(Number(ms)).toISOString();
  if (typeof ms === "number") return new Date(ms).toISOString();
  const created = str(o.created_at);
  if (created) {
    const d = new Date(created);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fallback;
}

const actorFields = (user: Obj) => ({
  actorId: str(user.id_str) ?? str(user.id),
  actorHandle: str(user.screen_name),
  actorName: str(user.name),
});

/**
 * Parse an X Account Activity payload into normalized events. Defensive: unknown or
 * malformed entries are skipped, and the caller's OWN activity (authored by
 * for_user_id) is dropped so we never record our own posts/DMs as inbound
 * engagement. `nowIso` is the fallback timestamp (inject in tests for determinism).
 */
export function parseXActivity(rawBody: string, nowIso: string): ParsedXActivity {
  let payload: Obj;
  try {
    payload = asObj(JSON.parse(rawBody));
  } catch {
    return { forUserId: null, events: [], truncated: false };
  }
  const forUserId = str(payload.for_user_id) ?? null;
  const events: ParsedXEvent[] = [];
  const self = forUserId; // drop our own activity
  const push = (e: ParsedXEvent) => {
    if (events.length < MAX_EVENTS_PER_BATCH) events.push(e);
  };

  // Tweets: reply / quote / repost / mention.
  for (const raw of asArr(payload.tweet_create_events)) {
    const tw = asObj(raw);
    const actor = actorFields(asObj(tw.user));
    const remoteId = str(tw.id_str) ?? str(tw.id);
    if (!actor.actorId || !remoteId || actor.actorId === self) continue;
    const text = str(tw.text) ?? str(tw.full_text);
    let type: SocialEventType;
    let targetRemoteId: string | undefined;
    if (asObj(tw.retweeted_status).id_str || asObj(tw.retweeted_status).id) {
      type = "repost";
      targetRemoteId = str(asObj(tw.retweeted_status).id_str) ?? str(asObj(tw.retweeted_status).id);
    } else if (str(tw.in_reply_to_status_id_str)) {
      type = "reply";
      targetRemoteId = str(tw.in_reply_to_status_id_str);
    } else if (tw.is_quote_status === true) {
      type = "quote";
      targetRemoteId = str(tw.quoted_status_id_str);
    } else {
      type = "mention";
    }
    push({ type, remoteId, ...actor, actorId: actor.actorId, targetRemoteId, text, ts: tsOf(tw, nowIso) });
  }

  // Likes.
  for (const raw of asArr(payload.favorite_events)) {
    const fav = asObj(raw);
    const actor = actorFields(asObj(fav.user));
    const target = str(asObj(fav.favorited_status).id_str) ?? str(asObj(fav.favorited_status).id);
    if (!actor.actorId || !target || actor.actorId === self) continue;
    // A user can like a tweet once → synthesize a stable, injective dedupe id.
    push({
      type: "like",
      remoteId: pairKey(target, actor.actorId),
      ...actor,
      actorId: actor.actorId,
      targetRemoteId: target,
      ts: tsOf(fav, nowIso),
    });
  }

  // Follows.
  for (const raw of asArr(payload.follow_events)) {
    const fe = asObj(raw);
    if (str(fe.type) && fe.type !== "follow") continue;
    const actor = actorFields(asObj(fe.source));
    if (!actor.actorId || actor.actorId === self) continue;
    push({
      type: "follow",
      remoteId: actor.actorId, // one follow per actor
      ...actor,
      actorId: actor.actorId,
      ts: tsOf(fe, nowIso),
    });
  }

  // Direct messages.
  const users = asObj(payload.users);
  for (const raw of asArr(payload.direct_message_events)) {
    const dm = asObj(raw);
    if (dm.type && dm.type !== "message_create") continue;
    const mc = asObj(dm.message_create);
    const senderId = str(mc.sender_id);
    const remoteId = str(dm.id);
    if (!senderId || !remoteId || senderId === self) continue; // drop DMs we sent
    // Object.hasOwn guards against reading Object.prototype for a "__proto__" sender.
    const senderUser = Object.hasOwn(users, senderId) ? asObj(users[senderId]) : {};
    push({
      type: "dm",
      remoteId,
      actorId: senderId,
      actorHandle: str(senderUser.screen_name),
      actorName: str(senderUser.name),
      text: str(asObj(mc.message_data).text),
      ts: tsOf(dm, nowIso),
    });
  }

  return { forUserId, events, truncated: events.length >= MAX_EVENTS_PER_BATCH };
}
