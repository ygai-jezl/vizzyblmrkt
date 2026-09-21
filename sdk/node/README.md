# @yougrow/node

Connect your product to YouGrow lifecycle journeys. Your server sends YouGrow
what your users do (sign-ups, onboarding steps). YouGrow then asks your server
for fresh context just before it emails someone.

> Status: pre-release (not yet on npm). The wire protocol is stable. The same
> signing works from any language; see "Without the SDK" below.

## Send events

```ts
import { YouGrow } from "@yougrow/node";

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

Before an email, YouGrow sends your context endpoint a signed `POST` about one
user. Verify the signature against the raw body, then reply:

```ts
import { verifyRequest, contextResponse } from "@yougrow/node/server";

app.post("/yougrow/context", express.raw({ type: "application/json" }), async (req, res) => {
  const rawBody = req.body.toString("utf8");
  const ok = verifyRequest({ headers: req.headers, rawBody, secret: process.env.YOUGROW_SECRET!, direction: "context" });
  if (!ok.ok) return res.status(401).end();

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

Numbers about the user appear only in your facts and insight sentences. YouGrow
never invents them.

## Webhooks

YouGrow tells your webhook endpoint about preference changes, e.g. an
unsubscribe from onboarding tips. Verify with
`verifyRequest({ …, direction: "webhook" })`.

## Without the SDK

Sign the exact request body:

```
X-YouGrow-Key-Id:    <key id>
X-YouGrow-Timestamp: <unix seconds>
X-YouGrow-Signature: v1=<hex HMAC-SHA256(secret, "<direction>:<timestamp>.<raw body>")>
```

`direction` is `events` for what you send, and `context` / `webhook` for what
YouGrow sends you. Requests more than five minutes out are refused.
`test/vectors.json` holds reference signatures for checking your implementation.
