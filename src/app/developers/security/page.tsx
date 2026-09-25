import { C, Code, Fields, H1, H2, H3, Lead, Note, OL, P, UL } from "@/components/developers/Doc";
import { docsOrigin, SDK_DEFAULT_ORIGIN } from "@/lib/developers/flags";

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

const verifier = createVerifier({ keyId: process.env.YOUGROW_KEY_ID!${origin === SDK_DEFAULT_ORIGIN ? "" : `, origin: "${origin}"`} });
const v = await verifier.verify({ headers: req.headers, rawBody, direction: "context" });
if (!v.ok) return res.status(401).end();`}</Code>
      <P>
        It fetches and caches the key set, refetches when we rotate keys, and keeps working on cached keys if a refresh
        fails. New keys are published a day before they&apos;re used, so rotations never break you. Create it once, outside
        your handler, so the keys stay cached between requests.
        {origin !== SDK_DEFAULT_ORIGIN ? (
          <>
            {" "}
            It trusts <C>{SDK_DEFAULT_ORIGIN}</C> unless told otherwise, hence <C>origin</C> (0.2.0 and later; earlier
            versions take <C>{`issuer: "${origin}"`}</C>).
          </>
        ) : null}
      </P>
      <Note tone="warn">
        Verify against the <strong>raw</strong> body. Frameworks that parse JSON first can re-serialize it with different
        bytes, and the body hash won&apos;t match — read the raw body, verify, then parse.
      </Note>

      <H2 id="raw-body">Reading the raw body</H2>
      <P>
        Most frameworks parse JSON before your handler runs. Here&apos;s how to get the exact bytes in each — then verify,
        then parse. (<C>verify</C> takes a string, or a Buffer from 0.2.0.)
      </P>
      <Code title="Express">{`app.post("/yougrow/context", express.raw({ type: "application/json" }), async (req, res) => {
  const rawBody = req.body.toString("utf8"); // a Buffer, because of express.raw()
  // … verify, then JSON.parse(rawBody)
});`}</Code>
      <Code title="Next.js — App Router (app/yougrow/context/route.ts)">{`export async function POST(req: Request) {
  const rawBody = await req.text();
  const v = await verifier.verify({ headers: req.headers, rawBody, direction: "context" });
  if (!v.ok) return Response.json({ error: v.reason }, { status: 401 });
  // … JSON.parse(rawBody)
}`}</Code>
      <Code title="Next.js — Pages Router (pages/api/yougrow/context.ts)">{`export const config = { api: { bodyParser: false } }; // keep the body unparsed

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  const rawBody = Buffer.concat(chunks).toString("utf8");
  // … verify, then JSON.parse(rawBody)
}`}</Code>
      <Code title="Firebase / Cloud Functions (onRequest)">{`export const yougrowContext = onRequest(async (req, res) => {
  const rawBody = req.rawBody.toString("utf8"); // req.body is already parsed; rawBody is the exact bytes
  // … verify, then JSON.parse(rawBody)
});`}</Code>
      <Code title="Fastify">{`app.register(async (scope) => {
  // For these routes only: hand JSON bodies over as the raw string.
  scope.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
  scope.post("/yougrow/context", async (req, reply) => {
    const rawBody = req.body as string;
    // … verify, then JSON.parse(rawBody)
  });
});`}</Code>
      <Code title="NestJS">{`const app = await NestFactory.create(AppModule, { rawBody: true }); // main.ts

@Post("yougrow/context")
async context(@Req() req: RawBodyRequest<Request>) {
  const rawBody = req.rawBody!.toString("utf8");
  // … verify, then JSON.parse(rawBody)
}`}</Code>
      <Code title="AWS Lambda (API Gateway or a function URL)">{`export const handler = async (event) => {
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event.body ?? "";
  const v = await verifier.verify({ headers: event.headers, rawBody, direction: "context" });
  // …
};`}</Code>
      <P>
        Use a Node runtime: the SDK uses <C>node:crypto</C>, so it doesn&apos;t run on edge runtimes (Vercel Edge Functions,
        Next.js middleware, Cloudflare Workers). On a serverless platform, a cold start plus the first key fetch has to
        fit inside your context endpoint&apos;s timeout — keep the verifier at module scope, and consider keeping one
        instance warm.
      </P>

      <H2 id="vectors">Test vectors</H2>
      <P>
        <a className="underline" href="/developers/test-vectors.json">test-vectors.json</a> holds reference HMAC
        signatures and ES256 tokens (with the public key that verifies them) so you can check your implementation in any
        language. The same file ships in the SDK package as <C>test/vectors.json</C>.
      </P>
    </article>
  );
}
