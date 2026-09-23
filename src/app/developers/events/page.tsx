import Link from "next/link";
import { C, Code, Fields, H1, H2, H3, Lead, Note, P, UL } from "@/components/developers/Doc";
import { docsOrigin } from "@/lib/developers/flags";

export default function EventsDocs() {
  const origin = docsOrigin();
  return (
    <article>
      <H1>Sending events</H1>
      <Lead>
        Your server tells YouGrow what your users do. Events build each user&apos;s profile, start journeys and move
        people between branches.
      </Lead>

      <H2 id="request">The request</H2>
      <Code>{`POST ${origin}/api/v1/events
Content-Type: application/json
X-YouGrow-Key-Id:    <your key id>
X-YouGrow-Timestamp: <unix seconds>
X-YouGrow-Signature: v1=<hex HMAC-SHA256(secret, "events:" + timestamp + "." + rawBody)>

{ "batch": [ <message>, … ] }`}</Code>
      <UL>
        <li>Send from your <strong>server</strong> only. The secret must never reach a browser or app bundle.</li>
        <li>
          Sign the <strong>exact bytes</strong> you send. Timestamps more than five minutes from our clock are refused.
          See <Link className="underline" href="/developers/security#signing-events">signing events</Link>.
        </li>
        <li>1–100 messages per request, up to 512 KB per request.</li>
      </UL>

      <H2 id="messages">Messages</H2>
      <P>Every message needs a unique <C>messageId</C>. Sending the same one again is harmless — it&apos;s counted as a duplicate, so you can retry freely.</P>
      <H3>identify — who the user is</H3>
      <Code>{`{
  "type": "identify",
  "messageId": "a2c9…",                 // unique, ≤ 128 chars
  "userId": "user_123",                 // YOUR id for the user, ≤ 256 chars
  "timestamp": "2026-09-23T10:00:00Z",  // ISO 8601 WITH a timezone
  "traits": { "email": "alex@acme.com", "firstName": "Alex", "timezone": "Europe/London", "plan": "free" },
  "consent": { "basis": "soft_opt_in" }
}`}</Code>
      <Fields
        rows={[
          ["traits", "object", <>Up to 50 keys (letters, digits, <C>_</C>, <C>-</C>; start with a letter). Values: string (≤ 500), number, boolean or null. <C>email</C>, <C>firstName</C>, <C>lastName</C>, <C>timezone</C> (IANA, e.g. Europe/London) and <C>locale</C> have special meaning; everything else is a trait journeys can branch on.</>],
          ["consent.basis", "string", <><C>consent</C>, <C>soft_opt_in</C>, <C>corporate_subscriber</C> or <C>none</C> — your legal basis for marketing email. Service emails (like a welcome) don&apos;t need one.</>],
          ["consent.source", "string?", "Where it was captured, ≤ 64 chars (for your audit trail)."],
        ]}
      />
      <Note>
        Send the user&apos;s <strong>timezone</strong>. Emails go out in each person&apos;s own morning; without it we
        use the connection&apos;s default timezone.
      </Note>

      <H3>track — what the user did</H3>
      <Code>{`{
  "type": "track",
  "messageId": "7f1e…",
  "userId": "user_123",
  "timestamp": "2026-09-23T10:05:00Z",
  "event": "onboarding.step_completed",
  "properties": { "step": "create_brand" }
}`}</Code>
      <Fields
        rows={[
          ["event", "string", <>Lower-case, dot-separated words, ≤ 80 chars — e.g. <C>report.exported</C>.</>],
          ["properties", "object", "Anything useful, ≤ 4 KB serialized."],
          ["traits", "object?", "Optional trait updates, same rules as identify."],
        ]}
      />

      <H2 id="reserved">Reserved events</H2>
      <Fields
        rows={[
          ["user.signed_up", "track", "Starts sign-up journeys. Send it once, at sign-up, alongside an identify. Events older than the journey's limit (72 hours by default) don't enrol, so a backfill won't email everyone."],
          ["onboarding.step_completed", "track", <><C>properties.step</C> is the step id from your catalog (lower-case letters, digits, <C>_</C>, <C>-</C>). Send it when the step becomes done — see below.</>],
          ["onboarding.completed", "track", "Every onboarding step is done."],
          ["email_preferences.updated", "track", <><C>properties.category</C> (e.g. <C>onboarding</C>) and <C>properties.subscribed</C> (boolean) — when someone changes email preferences in your product.</>],
          ["user.deleted", "track", "Erase this user and their history from YouGrow. Send it when the account is deleted (after any grace period you have)."],
        ]}
      />
      <P>Any other event name is recorded as a milestone that journeys can branch on (&ldquo;has exported a report&rdquo;).</P>

      <H2 id="steps">Reporting onboarding steps</H2>
      <P>How you detect a completed step depends on your product. Your connection&apos;s Integration guide says which fits each step:</P>
      <UL>
        <li>
          <strong>A clear server moment</strong> (a record is created, a status becomes <C>completed</C>) — send{" "}
          <C>onboarding.step_completed</C> right there.
        </li>
        <li>
          <strong>Only derived from stored state</strong> (e.g. &ldquo;has more than one team member&rdquo;) — run a
          small scheduled job that checks each recent user and sends the event with a deterministic{" "}
          <C>messageId</C> such as <C>{"{userId}:step:{stepId}"}</C>. Repeats are ignored, so it can run every few
          minutes.
        </li>
      </UL>
      <P>Your context endpoint should report the same steps, so journeys always see the live state.</P>

      <H2 id="responses">Responses</H2>
      <Code>{`202 Accepted
{ "accepted": 2, "duplicates": 0, "rejected": [ { "index": 3, "messageId": "…", "reason": "timestamp_in_future" } ] }`}</Code>
      <P>A batch is accepted message by message: one bad message doesn&apos;t fail the others. Rejected messages also show in the connection&apos;s Events tab with their reason.</P>
      <Fields
        rows={[
          ["400 invalid_json / invalid_batch", "", "The body isn't valid JSON, or isn't { batch: [...] } with 1+ messages."],
          ["401 missing_signature / bad_signature / stale_timestamp / unknown_key", "", "Check the headers, the secret, the exact bytes you signed, and your server clock."],
          ["413 body_too_large / batch_too_large", "", "Over 512 KB, or more than 100 messages."],
          ["429 rate_limited", "", "Slow down; retry after the Retry-After header (seconds)."],
          ["5xx", "", "Retry with backoff. Your messageIds make retries safe."],
        ]}
      />
    </article>
  );
}
