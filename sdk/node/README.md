# @yougrowai/node

Connect your product to YouGrow lifecycle journeys. Your server sends YouGrow
what your users do (sign-ups, onboarding steps). YouGrow then asks your server
for fresh context just before it emails someone.

**Full documentation: https://yougrow.ai/developers.** This package, as
published on npm, and those docs are the contract. The source on GitHub isn't:
its main branch can be ahead of what's been released.

```sh
npm install @yougrowai/node
```

Node 18 or later, no dependencies. It works with `import` (ESM) and, from
0.2.0, with `require` (CommonJS), e.g. in Cloud Functions compiled to CommonJS:

```js
const { YouGrow } = require("@yougrowai/node");
const { createVerifier, contextResponse } = require("@yougrowai/node/server");
```

Server-side only: your secret must never reach a browser or app bundle. Edge
runtimes (Vercel Edge Functions, Next.js edge routes and middleware, Cloudflare
Workers) aren't supported yet, because the SDK uses `node:crypto`. Use a Node
runtime route or function.

> Status: 0.x. The wire protocol is stable; the SDK's API may still change
> before 1.0. The same signing works from any language; see "Without the SDK"
> below.

## Send events

```ts
import { YouGrow } from "@yougrowai/node";

const yg = new YouGrow({
  keyId: process.env.YOUGROW_KEY_ID!,   // from Products → your connection
  secret: process.env.YOUGROW_SECRET!,  // shown once; keep it server-side
  origin: process.env.YOUGROW_ORIGIN,   // optional; defaults to https://yougrow.ai
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

// From a scheduled check: a stable messageId means a repeat is counted once
yg.stepCompleted(user.id, "confirm_competitors", { messageId: `${user.id}:step:confirm_competitors` });

// In a serverless function, before returning (see below)
await yg.flush();
```

Messages are queued and sent in batches of at most 100. In a long-running
server that happens in the background, once 20 messages are queued or 5 seconds
after the first; call `await yg.close()` on shutdown to send the rest. The
background timer never keeps your process alive, so a function or script has to
wait for its sends itself.

A request that takes more than 10 seconds is abandoned. Network errors,
timeouts, 429 and 5xx are retried with backoff. Every message has a
`messageId`, so a retry is never double-counted. A batch that still can't be
sent (after any retries) is dropped and reported: `flush()` rejects with the
error if it made the request; a background send's error goes to your
`onError`, or, if you didn't pass one, to one `console.warn` line (never your
secret or the messages).

### Serverless and scripts

- **Cloud Functions, Lambda, Vercel functions:** `await yg.flush()` before
  returning. From 0.2.0, `flush()` also waits for sends already in progress,
  so nothing is still in flight when your function ends.
- **Scripts:** `await yg.close()` before exiting.
- **Batch jobs** (imports, scheduled checks) are fine: queue as many messages
  as you like. Background sends go one request at a time, up to 100 messages
  each, and `await yg.close()` at the end waits for all of them.

```ts
export const onSignup = functions.auth.user().onCreate(async (user) => {
  yg.identify({ userId: user.uid, traits: { email: user.email ?? null } });
  yg.track({ userId: user.uid, event: "user.signed_up" });
  await yg.flush(); // before returning, or the send may never happen
});
```

### Options

| Option | Default | |
|---|---|---|
| `origin` | `https://yougrow.ai` | YouGrow's origin. Set it (e.g. from `YOUGROW_ORIGIN`) when you're connected to another YouGrow instance, such as staging or a self-hosted one. |
| `endpoint` | `${origin}/api/v1/events` | The full ingest URL, e.g. through a proxy. Wins over `origin`. |
| `flushAt` | `20` | Send once this many messages are queued (at most 100). |
| `flushIntervalMs` | `5000` | Send this long after the first queued message. `0`: only when you call `flush()`. |
| `timeoutMs` | `10000` | Abandon a request after this long; it's retried like a network error. |
| `maxRetries` | `3` | Retries per batch for network errors, timeouts, 429 and 5xx. |
| `maxRetryWaitMs` | `5000` | The longest wait between retries. `Retry-After` is honoured up to this. |
| `onError` | one `console.warn` line | Called with the error when a background send fails for good. |
| `fetch` | global `fetch` | A custom fetch (tests, proxies). |

A batch that keeps failing takes at most `(maxRetries + 1) × timeoutMs`, plus
the waits between retries. For a function with a short time limit, lower
`timeoutMs` or `maxRetries`. If a large import is rate-limited (429), raise
`maxRetryWaitMs` (e.g. to `60000`) so its retries wait for the limit to reset.

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
  origin: process.env.YOUGROW_ORIGIN, // optional; the same value as the client's
});

app.post("/yougrow/context", express.raw({ type: "application/json" }), async (req, res) => {
  // Verify the RAW body (here a Buffer) before parsing it.
  const v = await verifier.verify({ headers: req.headers, rawBody: req.body, direction: "context" });
  if (!v.ok) return res.status(401).end();

  const { userId } = JSON.parse(req.body.toString("utf8"));
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

`verify` takes the body exactly as received, as a string or a Buffer (e.g.
`req.rawBody` in Firebase Cloud Functions), never re-serialised JSON. Plain
header objects match in any case (e.g. API Gateway's `event.headers`). How to
read the raw body in each framework: https://yougrow.ai/developers/security.

The verifier fetches `<origin>/.well-known/jwks.json` once. It caches the keys
for as long as their `Cache-Control` allows, and refetches early when a token
names a key it hasn't seen. That means YouGrow can rotate its keys without any
change on your side.

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
   signature with the key from `<origin>/.well-known/jwks.json` whose `kid`
   matches. Cache that file per its `Cache-Control`.
2. `iss` is YouGrow's origin (`https://yougrow.ai` unless you're connected to
   another instance), and `aud` is your key id.
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

If your connection is on a YouGrow instance other than https://yougrow.ai (e.g.
a staging or self-hosted one), also set `YOUGROW_ORIGIN` to its origin, and
pass it as `origin` to both `new YouGrow()` and `createVerifier()`.
