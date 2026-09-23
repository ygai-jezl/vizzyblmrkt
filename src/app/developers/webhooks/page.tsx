import Link from "next/link";
import { C, Code, Fields, H1, H2, H3, Lead, Note, OL, P, UL } from "@/components/developers/Doc";

export default function WebhooksDocs() {
  return (
    <article>
      <H1>Webhooks</H1>
      <Lead>
        When someone unsubscribes from one of our emails, YouGrow tells your server — so your product&apos;s own email
        settings say the same thing, and your other emails respect it too.
      </Lead>
      <Note>
        <strong>Compliance.</strong> Without a webhook, our own unsubscribe links still work — we stop sending straight
        away. But your product won&apos;t know, so its settings page shows the person as subscribed, and emails you send
        yourself keep going to someone who opted out.
      </Note>

      <H2 id="what">What happens</H2>
      <OL>
        <li>
          Alex clicks <strong>Unsubscribe</strong> in an onboarding email (or uses the one-click unsubscribe in their mail
          app).
        </li>
        <li>We stop sending Alex that type of email immediately — nothing depends on your server for that.</li>
        <li>
          We send your webhook endpoint a signed <C>email_preferences.updated</C> for Alex&apos;s <strong>user id</strong>{" "}
          and the <strong>category</strong> they left (e.g. <C>onboarding</C>).
        </li>
        <li>Your server turns off the matching setting on Alex&apos;s account, and replies <C>200</C>.</li>
      </OL>
      <P>
        It works the other way too: when someone changes their email preferences <em>in your product</em>, send us{" "}
        <C>email_preferences.updated</C> as an{" "}
        <Link className="underline" href="/developers/events#other">
          event
        </Link>
        .
      </P>

      <H2 id="setup">What you need in place</H2>
      <OL>
        <li>
          An HTTPS endpoint on your server that accepts <C>POST</C> — public, port 443, answering directly (redirects
          aren&apos;t followed).
        </li>
        <li>
          Verification of every request with YouGrow&apos;s public keys (direction <C>webhook</C>) —{" "}
          <Link className="underline" href="/developers/security#verifying">
            how
          </Link>
          . Reject anything that doesn&apos;t verify with <C>401</C>.
        </li>
        <li>A <C>2xx</C> reply within 5 seconds. Do slow work afterwards.</li>
        <li>
          The URL saved in your connection&apos;s <strong>Settings → Webhook endpoint</strong>, then press{" "}
          <strong>Test webhook</strong>.
        </li>
      </OL>

      <H2 id="payload">The request</H2>
      <Code>{`POST https://api.your-app.com/yougrow/webhook
Content-Type: application/json
Authorization: Bearer <JWT signed by YouGrow>
X-YouGrow-Key-Id: <your key id>

{
  "id": "wh_7c1d…",
  "type": "email_preferences.updated",
  "createdAt": "2026-09-23T10:00:00Z",
  "data": {
    "userId": "user_123",
    "category": "onboarding",
    "subscribed": false,
    "scope": "category",
    "source": "list-unsubscribe"
  }
}`}</Code>
      <H3>Types</H3>
      <Fields
        rows={[
          ["email_preferences.updated", "", "Someone changed an email preference from one of our emails. Mirror it in your product."],
          ["connection.test", "", "Sent by Test webhook in YouGrow. Verify it and reply 2xx; there's nothing to change."],
        ]}
      />
      <P>
        More types may be added. Reply <C>2xx</C> to any type you don&apos;t handle, so it isn&apos;t retried.
      </P>
      <H3>email_preferences.updated — data</H3>
      <Fields
        rows={[
          ["userId", "string", <><strong>Your</strong> user id, exactly as you sent it in events. Payloads never contain an email address.</>],
          ["category", "string", <>The type of email they left — the journey&apos;s unsubscribe category, e.g. <C>onboarding</C>. Map it to your own setting.</>],
          ["subscribed", "boolean", <>Always <C>false</C> today (an unsubscribe).</>],
          ["scope", "string", <><C>category</C>: just this type of email. <C>all</C>: they chose to stop <em>every</em> email from you on our preferences page — turn off all your marketing email for them.</>],
          ["source", "string", <><C>list-unsubscribe</C> (the one-click button in their mail app) or <C>preferences-page</C> (the link in our footer). For your records.</>],
        ]}
      />

      <H2 id="example">A complete example (Node)</H2>
      <Code title="Express">{`import express from "express";
import { createVerifier } from "@yougrow/node/server";

const verifier = createVerifier({ keyId: process.env.YOUGROW_KEY_ID! });
const app = express();

// Map our categories to your own email settings.
const SETTING = { onboarding: "productTips" } as const;

// Verify against the RAW body — parse only after it checks out.
app.post("/yougrow/webhook", express.raw({ type: "application/json", limit: "16kb" }), async (req, res) => {
  const rawBody = req.body.toString("utf8");
  const v = await verifier.verify({ headers: req.headers, rawBody, direction: "webhook" });
  if (!v.ok) return res.status(401).json({ error: v.reason });

  const hook = JSON.parse(rawBody);
  if (await db.webhooksSeen.has(hook.id)) return res.status(200).end();    // a retry we already handled

  if (hook.type === "email_preferences.updated") {
    const { userId, category, subscribed, scope } = hook.data;
    if (scope === "all") {
      await db.users.update(userId, { marketingEmail: false });
    } else if (category in SETTING) {
      await db.users.update(userId, { [SETTING[category as keyof typeof SETTING]]: subscribed });
    }
  }
  await db.webhooksSeen.add(hook.id);                                        // keep ids for a few days
  res.status(200).end();                                                     // any other type: 2xx, nothing to do
});`}</Code>
      <P>
        Not using Node? Any JWT library works — the checks are in{" "}
        <Link className="underline" href="/developers/security#verifying">
          verifying our requests
        </Link>
        .
      </P>

      <H2 id="delivery">Delivery and retries</H2>
      <UL>
        <li>
          A reply that isn&apos;t <C>2xx</C>, or no reply within 5 seconds, is retried: after 1 minute, then 2, 4, 8 …
          up to every 6 hours, for 24 hours. After that it&apos;s dropped — the unsubscribe itself still stands on our
          side.
        </li>
        <li>
          A retry carries the <strong>same <C>id</C></strong> (also the token&apos;s <C>jti</C>). If your server did the
          work but the reply got lost, you&apos;ll see it again — skip ids you&apos;ve handled. Setting a preference to the
          same value twice is harmless anyway.
        </li>
        <li>
          Your connection shows the last delivery error, and <strong>Test webhook</strong> shows exactly what your server
          replied.
        </li>
      </UL>
      <Note>
        Your connection secret isn&apos;t involved: requests are signed with YouGrow&apos;s key and verified with its
        public keys, so nothing you store can be used to forge them.
      </Note>
    </article>
  );
}
