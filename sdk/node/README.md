# @yougrowai/node

Keep your users' state in YouGrow lifecycle journeys, and verify the requests
YouGrow sends you. Your server tells YouGrow who each user is and how far
they've got: sign-up, onboarding steps, facts, opt-outs. YouGrow decides which
journeys they're in, and what to send them when.

**Full documentation: https://yougrow.ai/developers.** The published package and
https://yougrow.ai/developers are the contract. The source on GitHub isn't: its
main branch can be ahead of what's been released.

> **2026-09-25:** API v1 (`POST /api/v1/events`, HMAC signing) was removed.
> 0.3.0 is the client for API v2; 0.1.x only spoke v1, so upgrade to keep
> sending. See [Upgrading from 0.1.x](#upgrading-from-01x).

```sh
npm install @yougrowai/node
```

Node 18 or later, no dependencies. It works with `import` (ESM) and `require`
(CommonJS), e.g. in Cloud Functions compiled to CommonJS:

```js
const { YouGrow } = require("@yougrowai/node");
const { createVerifier, contextResponse } = require("@yougrowai/node/server");
```

Server-side only: your secret must never reach a browser or app bundle.

> Status: 0.x. The HTTP API is versioned (`/api/v2`); the SDK's own API may
> still change before 1.0.

## Quick start

```ts
import { YouGrow } from "@yougrowai/node";

const yg = new YouGrow({
  keyId: process.env.YOUGROW_KEY_ID!,   // from Products → your connection
  secret: process.env.YOUGROW_SECRET!,  // shown once; keep it server-side
  origin: process.env.YOUGROW_ORIGIN,   // optional; defaults to https://yougrow.ai
});

// At sign-up: who they are, and the basis for emailing them
await yg.users.update(user.id, {
  email: user.email,
  firstName: user.firstName,
  timezone: user.timezone,               // IANA, e.g. "Europe/London"
  signedUpAt: user.createdAt.toISOString(),
  consent: "soft_opt_in",                // consent | soft_opt_in | corporate_subscriber | none
});

// As they get going: onboarding steps, facts and traits, in the same kind of update
await yg.users.update(user.id, {
  steps: { create_brand: new Date().toISOString() },
  facts: { competitors_tracked: 3 },
  traits: { plan: "pro" },
});

// They turned lifecycle email off in your product's settings
await yg.users.update(user.id, { subscribed: false });

// Staff, test accounts, invited teammates: never email them
await yg.users.update(user.id, { excluded: { reason: "staff" } });

// They deleted their account: erase them from YouGrow too
await yg.users.delete(user.id);
```

Each call resolves once YouGrow has answered; nothing is sent in the
background. For `userId`, use your own stable user id, not an email address
(which can change).

### A scheduled sync

`users.batch` takes any number of users. It sends them 100 per request, one
request after another, and returns one result for the lot:

```ts
const result = await yg.users.batch(
  accounts.map((a) => ({
    userId: a.id,
    steps: { create_brand: a.brandCreatedAt?.toISOString() ?? null },
    facts: { competitors_tracked: a.competitorCount },
    updatedAt: a.updatedAt.toISOString(),
  })),
);
// { applied: 248, ignored: 1, failed: 1,
//   results: [{ index: 17, userId: "u_42", status: "failed", reason: "invalid", fields: [{ path, message }] }, …] }
```

One bad item never fails the rest. `results` lists only the ignored and failed
items; `index` is the item's position in the array you passed. If any item
fails, one `console.warn` line says how many, with the first few user ids and
reasons (never the data you sent). Pass `{ quiet: true }` to skip that line, or
`{ throwOnItemError: true }` to get a `YouGrowBatchError` instead, carrying the
result as `err.result`, once every item has been sent.

If a request fails outright (a 401, say, or a 5xx that outlasts the retries),
`users.batch` rejects there. The requests before it were applied, and sending
the whole batch again is harmless. Requests are also kept under the API's
512 KB body limit; an item too big for any request fails as `body_too_large`.

### Events (optional)

Journeys run on state, so events are optional. Use them for milestones worth
branching on:

```ts
await yg.events.track(user.id, "report.exported", {
  properties: { format: "pdf" },                  // optional, up to 4 KB
  occurredAt: new Date().toISOString(),           // optional
  idempotencyKey: `report.exported:${report.id}`, // optional: the same key is recorded once
});
// { recorded: true, duplicate: false }
```

Event names are lower-case and dotted. The user must exist first: an event for
a user YouGrow hasn't seen rejects with a 404 (`not_found`). Without an
`idempotencyKey`, the SDK sends a random one per call, so its own retries never
record an event twice. A key that was already recorded resolves
`{ recorded: false, duplicate: true }`. The v1 lifecycle events (`user.signed_up`,
`onboarding.step_completed`, …) are state now, and sending one is refused
(400); see [Upgrading from 0.1.x](#upgrading-from-01x).

## How an update merges

`users.update` sends the user's state as a JSON Merge Patch (RFC 7396):

- Fields you send replace YouGrow's; fields you leave out stay as they are.
- `null` clears a field: `{ lastName: null }`.
- `steps`, `facts` and `traits` merge key by key. `{ steps: { invite_team: "…" } }`
  adds that step and keeps the others; `{ traits: { plan: null } }` removes
  just `plan`.
- A step's value is when it was done (`null`: not done). Timestamps are ISO 8601
  with a zone (`Z` or `+01:00`), e.g. from `toISOString()`.
- `email`, `firstName`, `lastName`, `timezone` and `locale` are fields of their
  own, never traits. Unknown fields are refused (400), so a typo can't be
  silently dropped.
- Up to 50 steps, 50 facts and 50 traits per user. Step ids are lower-case
  letters, digits, `_` and `-`; trait keys start with a letter.

A user YouGrow hasn't seen is created by their first update.
`users.get(userId)` returns the state as YouGrow holds it, plus what YouGrow
decided: journey `enrolments`, and `optOuts` (unsubscribes made in YouGrow's
emails, which hold until the person lifts them; the API can't). It returns
`null` for a user YouGrow doesn't know.

## Stale writes

Set `updatedAt` to when you read the state you're sending. YouGrow ignores a
write older than the newest one it applied, so a slow retry or an out-of-order
job can't overwrite fresher state:

```ts
const r = await yg.users.update(user.id, { traits: { plan: user.plan }, updatedAt: user.updatedAt.toISOString() });
if (!r.applied) console.info(r.reason); // "stale_write" (with storedUpdatedAt) or "deleted_later"
```

An ignored write isn't an error: the call resolves with `applied: false` (in a
batch, the item is `ignored`). Writes without `updatedAt` always apply.

`users.delete` erases the user and their history. It always succeeds, even for
a user YouGrow never saw, so it's safe to repeat. A later write whose
`updatedAt` is from before the deletion is ignored (`deleted_later`); any other
write starts a fresh person, so stop sending a user once you've deleted them.

## Errors, retries and timeouts

Every method returns a promise; await it.

- A request that takes more than 10 s is abandoned. Timeouts, network errors,
  429 and 5xx are retried (3 times by default) with jittered backoff, waiting
  at most 5 s between tries; a 429's `Retry-After` is honoured up to that cap.
  Retries are safe: updates and deletes are idempotent, and events carry an
  idempotency key.
- Any other error status rejects straight away with a `YouGrowError`: `status`,
  `code` (the API's `error`, e.g. `invalid`, `unauthorized`, `body_too_large`),
  `fields` for a 400, and a message such as
  `YouGrow API 400 invalid: traits.plan: …`. A 429 or 5xx that outlasts the
  retries rejects the same way; a network error or timeout rejects with that
  error.
- A user id the API can't take (empty, over 256 characters, `"batch"`, `"."`
  or `".."`) rejects with a `TypeError` before anything is sent.

```ts
import { YouGrowError } from "@yougrowai/node";

try {
  await yg.users.update(user.id, patch);
} catch (err) {
  if (err instanceof YouGrowError && err.status === 400) console.error(err.message, err.fields); // [{ path, message }]
  throw err;
}
```

| Option | Default | |
|---|---|---|
| `origin` | `https://yougrow.ai` | YouGrow's origin. Set it (e.g. from `YOUGROW_ORIGIN`) when you're connected to another YouGrow instance, such as staging or a self-hosted one. |
| `timeoutMs` | `10000` | Abandon a request after this long; it's retried like a network error. |
| `maxRetries` | `3` | Retries per request for network errors, timeouts, 429 and 5xx. |
| `maxRetryWaitMs` | `5000` | The longest wait between retries. `Retry-After` is honoured up to this. |
| `fetch` | global `fetch` | A custom fetch (tests, proxies). |

A request that keeps failing takes at most `(maxRetries + 1) × timeoutMs`, plus
the waits between retries. For a function with a short time limit, lower
`timeoutMs` or `maxRetries`. If a large sync is rate-limited (429), raise
`maxRetryWaitMs` (e.g. to `60000`) so its retries wait for the limit to reset.

## Serverless

Every call is awaited: nothing is queued, nothing is sent in the background,
and there's nothing to flush or close. Once the promise resolves, YouGrow has
the update, so your function can return straight after:

```ts
const yg = new YouGrow({ keyId: process.env.YOUGROW_KEY_ID!, secret: process.env.YOUGROW_SECRET! }); // once, outside the handler

export const onSignup = functions.auth.user().onCreate(async (user) => {
  await yg.users.update(user.uid, {
    email: user.email ?? null,
    signedUpAt: new Date(user.metadata.creationTime).toISOString(),
  });
});
```

## Runtimes

Node 18 or later, as ESM or CommonJS. Edge runtimes (Vercel Edge Functions,
Next.js edge routes and middleware, Cloudflare Workers) aren't supported yet,
because the SDK uses `node:crypto`. Use a Node runtime route or function.

## Verify YouGrow's requests

YouGrow calls your server too: your context endpoint, just before it emails
someone, and your webhook endpoint. Every such request carries
`Authorization: Bearer <JWT>`, signed with **YouGrow's** private key. You
verify it against YouGrow's published public keys. Your secret isn't involved,
so nothing you store can be used to forge a request from YouGrow.

### Answer context requests

Before an email, YouGrow sends your context endpoint a `POST` about one user:

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

### Webhooks

YouGrow tells your webhook endpoint about preference changes, e.g. an
unsubscribe from onboarding tips. Verify it with
`verifier.verify({ …, direction: "webhook" })`. Webhook ids (`jti` in the
token, `id` in the body) are unique, so you can drop duplicates.

## Without the SDK

**The API** is HTTPS and JSON, with HTTP Basic auth: your key id as the
username, your secret as the password.

```sh
curl -X PATCH "https://yougrow.ai/api/v2/users/u_123" \
  -u "$YOUGROW_KEY_ID:$YOUGROW_SECRET" \
  -H "content-type: application/json" \
  -d '{"email":"alex@example.com","signedUpAt":"2026-09-25T10:00:00Z","consent":"soft_opt_in"}'
```

`PATCH`, `GET` and `DELETE /api/v2/users/{userId}` (URL-encode the id),
`POST /api/v2/users/batch` with `{ "users": [{ "userId": "…", …patch }] }`
(1–100 users), and `POST /api/v2/users/{userId}/events`. The full reference is
at https://yougrow.ai/developers.

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

`test/vectors.json` (included in this package) holds reference tokens for
checking your own verifier.

## Upgrading from 0.1.x

| 0.1.x (API v1) | 0.3.0 (API v2) |
|---|---|
| `identify({ userId, traits, consent })` | `users.update(userId, { email, firstName, …, consent, traits })`: profile fields are top-level, and `consent` is the basis itself, e.g. `"soft_opt_in"` |
| `track({ event: "user.signed_up" })` | `signedUpAt` in `users.update` |
| `stepCompleted(userId, step)`, `onboarding.completed` | `steps: { [step]: doneAt }` in `users.update` |
| `email_preferences.updated` | `subscribed` in `users.update` |
| `user.deleted` | `users.delete(userId)` |
| Any other `track()` | `events.track(userId, event, { properties })` |
| `flush()`, `close()`, `flushAt`, `flushIntervalMs`, `onError` | Gone with the queue: every method is awaited, and rejects if it fails |
| `sign`, `HEADERS`, `endpoint` | Gone: requests use HTTP Basic auth, to paths under `origin` |

`@yougrowai/node/server` (`createVerifier`, `contextResponse`) is unchanged.

## Credentials

Create a connection in YouGrow (**Products → Connect a product**) to get a key
id and a secret. Store them in your server's environment or secret manager as
`YOUGROW_KEY_ID` and `YOUGROW_SECRET`. Use a separate connection, with its own
key and secret, for each environment (e.g. staging and production).

If your connection is on a YouGrow instance other than https://yougrow.ai (e.g.
a staging or self-hosted one), also set `YOUGROW_ORIGIN` to its origin, and
pass it as `origin` to both `new YouGrow()` and `createVerifier()`.
