import { C, Code, Fields, H1, H2, H3, Lead, Note, OL, P, UL } from "@/components/developers/Doc";
import { docsOrigin } from "@/lib/developers/flags";

export default function SecurityDocs() {
  const origin = docsOrigin();
  return (
    <article>
      <H1>Signing &amp; verifying</H1>
      <Lead>
        Two directions, two mechanisms. What <em>you</em> send us is signed with your connection&apos;s secret. What{" "}
        <em>we</em> send you is signed with YouGrow&apos;s own key, which you verify with our published public keys —
        so nothing you store could ever be used to impersonate YouGrow.
      </Lead>

      <H2 id="keys">Your key id and secret</H2>
      <UL>
        <li><strong>Key id</strong> (<C>ygk_…</C>) — public. It identifies your connection, and it&apos;s the audience of our tokens.</li>
        <li>
          <strong>Secret</strong> (<C>ygs_…</C>) — shown once when you create the connection. Keep it in your
          server&apos;s secret manager. Never put it in source control, a browser, a mobile app or logs.
        </li>
        <li>
          <strong>Rotating:</strong> Settings → Rotate secret issues a new one; the old one keeps working for 24 hours
          so you can deploy without downtime. If a secret may have leaked, rotate immediately.
        </li>
      </UL>

      <H2 id="signing-events">Signing events you send</H2>
      <Code>{`timestamp = current unix time in seconds
signature = hex( HMAC-SHA256( secret, "events:" + timestamp + "." + rawBody ) )

X-YouGrow-Key-Id:    <key id>
X-YouGrow-Timestamp: <timestamp>
X-YouGrow-Signature: v1=<signature>`}</Code>
      <UL>
        <li>Sign the exact bytes you send — serialize the JSON once and send that string.</li>
        <li>We refuse timestamps more than 5 minutes from our clock; keep your server&apos;s clock in sync.</li>
        <li>
          During a rotation you may send several signatures separated by commas (<C>v1=…,v1=…</C>); one valid
          signature is enough.
        </li>
      </UL>

      <H2 id="verifying">Verifying our requests</H2>
      <P>
        Context requests and webhooks carry <C>Authorization: Bearer &lt;JWT&gt;</C>, signed with ES256 by a key held in
        Google Cloud KMS. Verify it <strong>before</strong> trusting anything in the request:
      </P>
      <OL>
        <li>
          Read the header&apos;s <C>kid</C> and find that key in <C>{`${origin}/.well-known/jwks.json`}</C>. Cache the
          key set as its <C>Cache-Control</C> allows; if a token names a key you don&apos;t have, fetch it again (at
          most once a minute).
        </li>
        <li>
          Check the signature, and that <C>alg</C> is <C>ES256</C>. Reject anything else, including <C>none</C> and
          HMAC algorithms.
        </li>
        <li>Check the claims:</li>
      </OL>
      <Fields
        rows={[
          ["iss", "string", <>Must be <C>{origin}</C>.</>],
          ["aud", "string", "Must be your connection's key id."],
          ["dir", "string", <><C>context</C> on your context endpoint, <C>webhook</C> on your webhook endpoint.</>],
          ["exp / iat", "number", "Not expired (allow ~60 s of clock skew); tokens live at most 5 minutes."],
          ["body_sha256", "string", "The base64url SHA-256 of the raw request body you received — so the body can't have been altered."],
          ["jti", "string", "Unique per request (the requestId or webhook id) — use it to drop repeats."],
        ]}
      />
      <H3>With the Node SDK</H3>
      <Code>{`import { createVerifier } from "@yougrowai/node/server";

const verifier = createVerifier({ keyId: process.env.YOUGROW_KEY_ID! });
const v = await verifier.verify({ headers: req.headers, rawBody, direction: "context" });
if (!v.ok) return res.status(401).end();`}</Code>
      <P>
        It fetches and caches the key set, refetches when we rotate keys, and keeps working on cached keys if a refresh
        fails. New keys are published a day before they&apos;re used, so rotations never break you.
      </P>
      <Note tone="warn">
        Verify against the <strong>raw</strong> body. Frameworks that parse JSON first can re-serialize it with different
        bytes, and the body hash won&apos;t match — read the raw body, verify, then parse.
      </Note>

      <H2 id="vectors">Test vectors</H2>
      <P>
        <C>sdk/node/test/vectors.json</C> in the SDK holds reference HMAC signatures and ES256 tokens (with the public
        key that verifies them) so you can check your implementation in any language.
      </P>
    </article>
  );
}
