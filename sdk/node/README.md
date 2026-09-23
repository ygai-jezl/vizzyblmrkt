# @yougrowai/node

Connect your product to YouGrow lifecycle journeys. Your server sends YouGrow
what your users do (sign-ups, onboarding steps). YouGrow then asks your server
for fresh context just before it emails someone.

```sh
npm install @yougrowai/node
```

Node 18 or later, no dependencies. Server-side only: your secret must never
reach a browser or app bundle.

> Status: 0.x. The wire protocol is stable; the SDK's API may still change
> before 1.0. The same signing works from any language; see "Without the SDK"
> below.

## Send events

```ts
import { YouGrow } from "@yougrowai/node";

const yg = new YouGrow({
  keyId: process.env.YOUGROW_KEY_ID!,   // from Products → your connection
  secret: process.env.YOUGROW_SECRET!,  // shown once; keep it server-side
});

// On sign-up
yg.identify({
  userId: user.id,
  traits: { email: user.email, firstName: user.firstName, timezone: "Europe/London", plan: "free" },
  consent: { basis: "soft_opt_in" }, // consent | soft_opt_in | corporate_subscriber | none
});
yg.track({ userId: user.id, event: "user.signed_up" });

// As onboarding progresses
yg.stepCompleted(user.id, "create_brand");

await yg.flush(); // or let it flush automatically (every 20 messages / 5 s)
```

Messages are batched (at most 100 per request) and retried with backoff on
network errors, 429 and 5xx. Every message has a `messageId`, so a retry is
never double-counted.

### Reserved events

| Event | Meaning |
|---|---|
| `user.signed_up` | Starts sign-up journeys |
| `onboarding.step_completed` | `properties.step` is the step id from your catalog |
| `onboarding.completed` | Every onboarding step is done |
| `email_preferences.updated` | `properties.category` + `properties.subscribed` |
| `user.deleted` | Erase this user and their history |

Other event names (lower-case, dotted, e.g. `report.exported`) are recorded as
milestones.

## Answer context requests

Before an email, YouGrow sends your context endpoint a `POST` about one user.
It carries `Authorization: Bearer <JWT>`, signed with **YouGrow's** private key.
You verify it against YouGrow's published public keys. Your secret isn't
involved, so nothing you store can be used to forge a request from YouGrow.

```ts
import { createVerifier, contextResponse } from "@yougrowai/node/server";

// Once, at startup. keyId is the token's audience: tokens for other connections fail.
const verifier = createVerifier({
  keyId: process.env.YOUGROW_KEY_ID!,
  // issuer: "https://<dev origin>"  // staging only; defaults to https://yougrow.ai
});

app.post("/yougrow/context", express.raw({ type: "application/json" }), async (req, res) => {
  const rawBody = req.body.toString("utf8");
  const v = await verifier.verify({ headers: req.headers, rawBody, direction: "context" });
  if (!v.ok) return res.status(401).end();

  const { userId } = JSON.parse(rawBody);
  const u = await loadOnboardingState(userId);
  res.type("json").send(
    contextResponse({
      steps: u.steps, // [{ id, label, done, url }]
      nextStep: u.nextStep,
      facts: [{ id: "sov", label: "Share of voice", value: 12, unit: "%" }],
      insights: [{ id: "sov", sentence: "Across 4 AI engines you appear in 12% of answers.", factIds: ["sov"] }],
      // exit: { reason: "staff" } stops lifecycle email for this user
    }),
  );
});
```

The verifier fetches `https://yougrow.ai/.well-known/jwks.json` once. It caches
the keys for as long as their `Cache-Control` allows, and refetches early when
a token names a key it hasn't seen. That means YouGrow can rotate its keys
without any change on your side.

Numbers about the user appear only in your facts and insight sentences. YouGrow
never invents them.

## Webhooks

YouGrow tells your webhook endpoint about preference changes, e.g. an
unsubscribe from onboarding tips. Verify it with
`verifier.verify({ …, direction: "webhook" })`. Webhook ids (`jti` in the
token, `id` in the body) are unique, so you can drop duplicates.

## Without the SDK

**Events you send** are signed with your secret, over the exact request body:

```
X-YouGrow-Key-Id:    <key id>
X-YouGrow-Timestamp: <unix seconds>
X-YouGrow-Signature: v1=<hex HMAC-SHA256(secret, "events:<timestamp>.<raw body>")>
```

Requests more than five minutes out are refused.

**Requests YouGrow sends you** carry a JWT. Use any JWT library, then check:

1. `alg` is `ES256` (reject anything else, including `none`). Verify the
   signature with the key from `<issuer>/.well-known/jwks.json` whose `kid`
   matches. Cache that file per its `Cache-Control`.
2. `iss` is `https://yougrow.ai`, and `aud` is your key id.
3. `dir` is `context` or `webhook`, matching the endpoint that received it.
4. `exp` hasn't passed, allowing about 60 s of clock skew. `exp − iat` is at
   most 300.
5. `body_sha256` is the base64url SHA-256 of the raw body you received.

`test/vectors.json` (included in this package) holds reference signatures and
tokens for checking your own implementation.

## Credentials

Create a connection in YouGrow (**Products → Connect a product**) to get a key
id and a secret. Store them in your server's environment or secret manager as
`YOUGROW_KEY_ID` and `YOUGROW_SECRET`. Use a separate connection, with its own
key and secret, for each environment (e.g. staging and production).
