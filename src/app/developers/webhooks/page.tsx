import Link from "next/link";
import { C, Code, Fields, H1, H2, Lead, Note, P, UL } from "@/components/developers/Doc";

export default function WebhooksDocs() {
  return (
    <article>
      <H1>Webhooks</H1>
      <Lead>
        YouGrow tells your server about changes your product should mirror — most importantly when someone
        unsubscribes from a type of email, so your own preferences stay in step.
      </Lead>

      <H2 id="setup">What you need in place</H2>
      <UL>
        <li>An HTTPS endpoint that accepts <C>POST</C> (public, port 443, no redirects), saved in your connection&apos;s <strong>Settings → Webhook endpoint</strong>.</li>
        <li>
          Verification of every request with YouGrow&apos;s public keys (direction <C>webhook</C>) —{" "}
          <Link className="underline" href="/developers/security#verifying">
            how
          </Link>
          .
        </li>
        <li>A <C>2xx</C> reply within 5 seconds. Do slow work afterwards.</li>
      </UL>

      <H2 id="payload">The payload</H2>
      <Code>{`POST https://api.your-app.com/yougrow/webhook
Authorization: Bearer <JWT signed by YouGrow>
X-YouGrow-Key-Id: <your key id>

{
  "id": "wh_7c1d…",
  "type": "email_preferences.updated",
  "createdAt": "2026-09-23T10:00:00Z",
  "data": { "userId": "user_123", "category": "onboarding", "subscribed": false }
}`}</Code>
      <Fields
        rows={[
          ["email_preferences.updated", "", <>Someone changed a preference from one of our emails, e.g. unsubscribed from <C>onboarding</C>. Mirror it in your product.</>],
          ["email.suppressed", "", "We'll no longer email this address (a hard bounce or a spam complaint)."],
          ["connection.test", "", "Sent by Test webhook in YouGrow. Reply 2xx."],
        ]}
      />
      <P>Payloads identify people by <strong>your</strong> <C>userId</C> — never an email address.</P>

      <H2 id="delivery">Delivery and retries</H2>
      <UL>
        <li>Any non-2xx reply or timeout is retried with backoff: 1 minute, then doubling, for up to 24 hours.</li>
        <li>
          Deliveries can repeat. Each webhook has a unique <C>id</C> (also the token&apos;s <C>jti</C>) — ignore ones
          you&apos;ve already handled.
        </li>
      </UL>
      <Note>Your connection secret isn&apos;t involved: requests are signed with YouGrow&apos;s key and verified with its public keys, so nothing you store can be used to forge them.</Note>
    </article>
  );
}
