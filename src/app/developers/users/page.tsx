import Link from "next/link";
import { C, Code, Fields, H1, H2, H3, Lead, Note, OL, P, UL } from "@/components/developers/Doc";
import { V2_LIMITS } from "@/lib/connect/v2/contract";
import { docsOrigin, SDK_DEFAULT_ORIGIN } from "@/lib/developers/flags";
import { codeText, USER_FIELDS, USER_ID_NOTES } from "@/lib/developers/userFields";

export default function UsersDocs() {
  const origin = docsOrigin();
  const api = `${origin}/api/v2/users`;
  const sdkOrigin = origin === SDK_DEFAULT_ORIGIN ? "" : `, origin: "${origin}"`;
  const kb = V2_LIMITS.maxBodyBytes / 1024;
  return (
    <article>
      <H1>Sending users</H1>
      <Lead>
        Your server tells YouGrow about each of your users: who they are, when they signed up, which onboarding steps
        they&apos;ve done, and a few facts about their account. You send their current state and YouGrow keeps it. Journeys
        do the rest — who gets which email, and when.
      </Lead>
      <Note>
        <strong>Only sign-ups are required</strong> for a journey to run. Steps and facts make it personal. Your
        product&apos;s <strong>Integration guide</strong> (Products → your product) lists what to send from your own code,
        with file pointers — and a <strong>Copy prompt</strong> button that hands the whole job to your coding agent.
      </Note>

      <H2 id="setup">Before you start</H2>
      <OL>
        <li>
          In YouGrow, <strong>Products → Connect a product</strong> gives you a <strong>key id</strong> (<C>ygk_…</C>, public)
          and a <strong>secret</strong> (<C>ygs_…</C>, shown once).
        </li>
        <li>
          Put them in your <strong>server&apos;s</strong> environment or secret manager as <C>YOUGROW_KEY_ID</C> and{" "}
          <C>YOUGROW_SECRET</C>, with <C>YOUGROW_ORIGIN</C> set to <C>{origin}</C>. Never in source control, a browser or a
          mobile app — anyone with the secret can change your users&apos; state.
        </li>
        <li>
          Call the API over HTTPS with HTTP Basic auth: the key id is the username and the secret is the password. There&apos;s
          nothing to sign. See{" "}
          <Link className="underline" href="/developers/security#authenticating">
            authentication
          </Link>{" "}
          for rotating the secret.
        </li>
      </OL>

      <H2 id="state">One call: send the user&apos;s state</H2>
      <P>
        <C>{"PATCH /api/v2/users/{userId}"}</C> with the fields you know. <C>userId</C> is <strong>your</strong> id for
        the user — use the same one everywhere. The first write for an id creates the user.
      </P>
      <Code title="Request">{`PATCH ${api}/user_123
Authorization: Basic <base64 of "key id:secret">
Content-Type: application/json

{
  "signedUpAt": "2026-09-25T09:30:00Z",
  "email": "alex@example.com",
  "firstName": "Alex",
  "timezone": "Europe/London",
  "consent": "soft_opt_in",
  "traits": { "plan": "pro" }
}`}</Code>
      <P>The body is a JSON Merge Patch (RFC 7396):</P>
      <UL>
        <li>Fields you send replace ours. Fields you leave out stay as they are.</li>
        <li>
          <C>null</C> clears a field.
        </li>
        <li>
          <C>steps</C>, <C>facts</C> and <C>traits</C> merge key by key: <C>{`{"traits": {"plan": "pro"}}`}</C> sets one trait
          and keeps the rest, and <C>{`{"traits": {"role": null}}`}</C> removes one.
        </li>
      </UL>
      <P>
        Sending the same state twice is harmless. So you can retry any write, and a scheduled job can send everything it
        knows every time it runs.
      </P>

      <H3>With curl</H3>
      <Code>{`curl -u "$YOUGROW_KEY_ID:$YOUGROW_SECRET" -X PATCH "${api}/user_123" \\
  -H "Content-Type: application/json" \\
  -d '{"signedUpAt": "2026-09-25T09:30:00Z", "email": "alex@example.com", "firstName": "Alex"}'`}</Code>

      <H3>With the Node SDK</H3>
      <P>
        <C>@yougrowai/node</C> 0.3.0 and later: it handles the auth, retries network errors, <C>429</C> and <C>5xx</C>{" "}
        responses, and splits big batches. It works from ES modules and CommonJS (<C>require</C>).
      </P>
      <Code title="yougrow.ts">{`// npm install @yougrowai/node
import { YouGrow } from "@yougrowai/node";

// Once, at module scope.
export const yg = new YouGrow({ keyId: process.env.YOUGROW_KEY_ID!, secret: process.env.YOUGROW_SECRET!${sdkOrigin} });

// Anywhere on your server:
await yg.users.update("user_123", { email: "alex@example.com", firstName: "Alex" });`}</Code>
      {sdkOrigin ? (
        <P>
          The SDK talks to <C>{SDK_DEFAULT_ORIGIN}</C> unless told otherwise, hence <C>origin</C> — or pass{" "}
          <C>origin: process.env.YOUGROW_ORIGIN</C>.
        </P>
      ) : null}

      <H3>With Python</H3>
      <Code title="yougrow.py">{`import os
from urllib.parse import quote
import requests

ORIGIN = os.environ["YOUGROW_ORIGIN"]                      # ${origin}
AUTH = (os.environ["YOUGROW_KEY_ID"], os.environ["YOUGROW_SECRET"])

def update_user(user_id, patch):
    url = f"{ORIGIN}/api/v2/users/{quote(user_id, safe='')}"
    r = requests.patch(url, json=patch, auth=AUTH, timeout=10)
    r.raise_for_status()
    return r.json()`}</Code>

      <H3>Without the SDK (any runtime with fetch)</H3>
      <Code title="yougrow.ts">{`const AUTH = "Basic " + btoa(\`\${process.env.YOUGROW_KEY_ID}:\${process.env.YOUGROW_SECRET}\`);

export async function updateUser(userId: string, patch: object) {
  const res = await fetch(\`\${process.env.YOUGROW_ORIGIN}/api/v2/users/\${encodeURIComponent(userId)}\`, {
    method: "PATCH",
    headers: { authorization: AUTH, "content-type": "application/json" },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(\`YouGrow \${res.status}: \${await res.text()}\`);
  return res.json(); // { applied, user } — see "Responses"
}`}</Code>

      <H2 id="signups">1. Sign-ups — required</H2>
      <H3>What</H3>
      <P>
        When someone creates an account, send <C>signedUpAt</C> and who they are: <C>email</C>, <C>firstName</C>,{" "}
        <C>timezone</C> and <C>consent</C>.
      </P>
      <H3>Where in your code</H3>
      <P>
        The one place your server creates a new user — <strong>after</strong> the account exists. Wherever that is in your
        stack, for example:
      </P>
      <UL>
        <li>right after the insert in your own sign-up / registration handler;</li>
        <li>
          a Firebase Auth <C>onCreate</C> trigger, a Supabase or database trigger on your users table, an Auth0
          post-registration action, NextAuth&apos;s <C>createUser</C> event, or a Django <C>post_save</C> signal on your user
          model.
        </li>
      </UL>
      <P>Not in the browser. Once per new account is enough, and sending it again is harmless.</P>
      <H3>How</H3>
      <Code title="In your sign-up handler (Node)">{`import { yg } from "./yougrow";

// after the user is created…
try {
  await yg.users.update(user.id, {                 // YOUR id for this user — use it everywhere
    signedUpAt: user.createdAt.toISOString(),
    email: user.email,
    firstName: user.firstName,
    timezone: user.timezone,                       // IANA name, e.g. "Europe/London" — see below
    consent: "soft_opt_in",                        // your legal basis for marketing email
    traits: { plan: user.plan },                   // anything else journeys can branch on
  });
} catch (err) {
  console.error("YouGrow sign-up failed", err);    // never block sign-up
}`}</Code>
      <Code title="In a serverless function (e.g. Firebase Auth onCreate)">{`const yg = new YouGrow({ keyId: process.env.YOUGROW_KEY_ID!, secret: process.env.YOUGROW_SECRET!${sdkOrigin} });

export const yougrowSignup = functions.auth.user().onCreate(async (user) => {
  await yg.users.update(user.uid, {
    signedUpAt: new Date(user.metadata.creationTime).toISOString(),
    email: user.email ?? null,
    firstName: user.displayName?.split(" ")[0] ?? null,
  });                                              // awaited: nothing is left running when the function returns
});`}</Code>
      <H3>Timezone</H3>
      <P>
        Emails go out in each person&apos;s morning, so send their IANA timezone (e.g. <C>America/New_York</C>). If you
        don&apos;t store one, capture it in the browser at sign-up with <C>Intl.DateTimeFormat().resolvedOptions().timeZone</C>{" "}
        and pass it to your server. Without it we use your connection&apos;s default timezone.
      </P>
      <H3>What happens on our side</H3>
      <P>
        We create the person&apos;s profile, and <C>signedUpAt</C> enrols them in every published journey that starts on
        sign-up — as long as they&apos;re inside the journey&apos;s sign-up window (72 hours by default), so importing past
        users won&apos;t email them all. We check on every write: a retry or a late write still enrols them while
        they&apos;re inside the window, and a journey that goes live later picks up people who still are at their next
        write. People who are{" "}
        <C>excluded</C>, or have <C>subscribed: false</C>, never enrol.
      </P>
      <H3>Check it works</H3>
      <P>
        Sign up a test account, then open <strong>Products → your product → Events</strong>: the write appears within
        seconds. A refused write gets a <C>400</C> that says what was wrong. Or read the user back with{" "}
        <a className="underline" href="#get">
          GET
        </a>
        .
      </P>
      <H3>Invited from a waitlist (optional)</H3>
      <P>
        When you invite your waitlist into your product, each invite link lands on your sign-up page with{" "}
        <C>?yg_invite=…</C> added. We already match sign-ups to invites by email. If you keep that value through sign-up and
        send it back as a trait (<C>{`traits: { yg_invite: "…" }`}</C>), the match also works when someone signs up with a
        different email. The value is an opaque code: it carries no personal data and grants nothing on its own.
      </P>

      <H2 id="steps">2. Onboarding steps and facts — personalisation</H2>
      <H3>What</H3>
      <UL>
        <li>
          <C>steps</C> — which onboarding steps each person has done, and when. Use the exact ids from your product&apos;s{" "}
          <strong>Catalog</strong> (e.g. <C>create_project</C>, <C>invite_team</C>). A step you haven&apos;t sent isn&apos;t
          done; <C>null</C> marks one not done again.
        </li>
        <li>
          <C>facts</C> — numbers (or short values) about their account that journeys can branch on and emails can mention,
          e.g. <C>{`"projects": 3`}</C>. Send the latest value; <C>null</C> removes one.
        </li>
        <li>
          <C>traits</C> — anything else journeys branch on, such as <C>plan</C> or <C>company</C>.
        </li>
      </UL>
      <Code>{`{
  "steps":  { "create_project": "2026-09-25T10:02:00Z", "invite_team": null },
  "facts":  { "projects": 3 },
  "traits": { "plan": "pro" }
}`}</Code>
      <H3>Where in your code — two ways</H3>
      <P>Your Integration guide says which fits each step:</P>
      <P>
        <strong>A. At a clear server moment</strong> — the step is a thing your server does: a project is created, a job
        finishes, an integration is connected. Add the call right after it succeeds:
      </P>
      <Code title="e.g. in your create-project handler">{`await db.projects.insert(project);
await yg.users
  .update(user.id, {
    steps: { create_project: project.createdAt.toISOString() },
    facts: { projects: await db.projects.count(user.id) },
  })
  .catch((err) => console.error("YouGrow update failed", err));`}</Code>
      <P>
        <strong>B. From a scheduled sync</strong> — the step is a <em>state</em> rather than a moment (&ldquo;has at least 3
        competitors&rdquo;, &ldquo;has invited a teammate&rdquo;), or it&apos;s only worked out in the browser today. Run a
        small job every 15 minutes or so that reads recent users from your database and sends what&apos;s true now. Sending
        the same state again is harmless, so it can run as often as you like:
      </P>
      <Code title="e.g. a job every 15 minutes">{`const readAt = new Date().toISOString();           // before reading, so a newer write wins
const users = await db.users.createdInLastDays(14);
const items = [];
for (const u of users) {
  const invite = await db.invites.firstSentBy(u.id);  // null until they've invited someone
  items.push({
    userId: u.id,
    steps: { invite_team: invite ? invite.createdAt.toISOString() : null },
    facts: { teammates: await db.members.count(u.teamId) },
    updatedAt: readAt,                                // see "Out-of-order writes"
  });
}
await yg.users.batch(items);                          // any number: the SDK sends 100 per request`}</Code>
      <P>
        A step&apos;s time is when it happened, not when your job ran: send the time you stored (such as the first
        invite&apos;s <C>createdAt</C>).
      </P>
      <H3>What happens on our side</H3>
      <P>
        We keep the steps and facts on the person&apos;s profile. Journeys branch on them — someone who&apos;s created a
        project is nudged towards the next step instead, and people who&apos;ve finished get education instead of reminders —
        and the checklist in your emails ticks them off.
      </P>
      <H3>And the context endpoint?</H3>
      <P>
        You don&apos;t need one: journeys use the state you send. If a value changes too fast to send — a number that moves
        by the minute — a{" "}
        <Link className="underline" href="/developers/context-endpoint">
          context endpoint
        </Link>{" "}
        lets YouGrow fetch it at the moment of sending. Use the same step and fact ids in both.
      </P>

      <H2 id="compliance">3. Consent, opt-outs, exclusions and deletion — compliance</H2>
      <Code>{`await yg.users.update(user.id, { consent: "consent" });              // they ticked "send me tips"
await yg.users.update(user.id, { subscribed: false });               // opted out in your settings
await yg.users.update(user.id, { excluded: { reason: "staff" } });   // never email this person
await yg.users.delete(user.id);                                       // the account is erased`}</Code>
      <H3>Consent: consent</H3>
      <P>
        Your legal basis for marketing email: <C>consent</C> (they opted in), <C>soft_opt_in</C> (an existing customer,
        told at sign-up and given a way to refuse), <C>corporate_subscriber</C> (a business address) or <C>none</C>. Send it
        at sign-up, and again if it changes. Service emails, like a welcome, don&apos;t need one; marketing emails do.{" "}
        <C>corporate_subscriber</C> counts as <C>none</C> for free-mail addresses (gmail.com, …).
      </P>
      <H3>Opt-outs: subscribed</H3>
      <P>
        When someone turns off this kind of email in your product&apos;s settings, send <C>{`"subscribed": false`}</C>. They
        get no more lifecycle email, and no new journey starts for them. Send <C>true</C> when they turn it back on.
      </P>
      <P>
        <C>true</C> only lifts <strong>your</strong> opt-out. When someone unsubscribes from one of <strong>our</strong>{" "}
        emails, the API can&apos;t lift it, and <C>subscribed: true</C> doesn&apos;t either. You&apos;ll see those as{" "}
        <C>optOuts</C> when you read the user back, and a{" "}
        <Link className="underline" href="/developers/webhooks">
          webhook
        </Link>{" "}
        tells your server when one happens.
      </P>
      <H3>Exclusions: excluded</H3>
      <P>
        For people who must never get lifecycle email — staff, test accounts, invited teammates — send{" "}
        <C>{`"excluded": {"reason": "staff"}`}</C>. It applies to every journey, straight away. Clearing it (
        <C>{`"excluded": null`}</C>) lets them into journeys that start from then on; it doesn&apos;t put them back into the
        ones they left.
      </P>
      <H3>Deletion: DELETE</H3>
      <P>
        When an account is erased (after any grace period you have), send <C>{"DELETE /api/v2/users/{userId}"}</C>.
        It always answers <C>204</C>, even for a user we never saw, so it&apos;s safe to repeat. While deletion is pending,
        set <C>excluded</C> (e.g. <C>{`{"reason": "deletion_pending"}`}</C>) so they get no more email in the meantime.
      </P>
      <UL>
        <li>
          <strong>Erased:</strong> the profile, its events, journey progress, AI drafts and invite links.
        </li>
        <li>
          <strong>Kept:</strong> opt-outs, with the email address removed. A one-way hash still matches it, so someone who
          unsubscribed stays unsubscribed if they sign up again.
        </li>
        <li>
          <strong>For 30 days:</strong> a tombstone holding only a one-way hash of your connection and user ids, and when
          they were deleted.
        </li>
      </UL>
      <P>
        A later write for the same id starts a fresh person — unless its <C>updatedAt</C> is older than the deletion. That
        write is ignored (<C>deleted_later</C>), so a slow sync can&apos;t bring back someone you erased.
      </P>

      <H2 id="events">Milestones (optional)</H2>
      <P>
        Journeys run on state, so most products never need events. When a moment matters in itself — a report exported, a
        first invoice paid — you can record it as a milestone, and a journey can start from it or branch on it.
      </P>
      <Code>{`POST ${api}/user_123/events

{ "event": "report.exported", "properties": { "format": "pdf" }, "occurredAt": "2026-09-25T10:15:00Z", "idempotencyKey": "export_8812" }

200 OK
{ "recorded": true, "duplicate": false }`}</Code>
      <Code title="Node SDK">{`await yg.events.track(user.id, "report.exported", { properties: { format: "pdf" } });`}</Code>
      <UL>
        <li>
          <C>event</C>: lower-case, dot-separated, ≤ 80 chars. <C>onboarding.completed</C> marks the user activated — for a
          product without a step checklist, or to say they&apos;re done.
        </li>
        <li>
          Sign-ups, steps, consent, opt-outs and deletion are state, so <C>user.signed_up</C>,{" "}
          <C>onboarding.step_completed</C>, <C>user.marketing_consent_granted</C>, <C>email_preferences.updated</C> and{" "}
          <C>user.deleted</C> are refused: send <C>signedUpAt</C>, <C>steps</C>, <C>consent</C> or <C>subscribed</C>, or
          DELETE the user.
        </li>
        <li>
          <C>properties</C>: optional, ≤ {V2_LIMITS.maxPropertiesBytes / 1024} KB serialised. <C>occurredAt</C>: optional,
          when it happened (defaults to now).
        </li>
        <li>
          <C>idempotencyKey</C>: optional. The same key is recorded once — a repeat answers <C>{`"duplicate": true`}</C>. The
          SDK sets a random one per call, so its own retries never count twice.
        </li>
        <li>
          The user must exist: send their state first. An event for a user we don&apos;t hold gets <C>404</C>.
        </li>
      </UL>

      <H2 id="updated-at">Out-of-order writes: updatedAt</H2>
      <P>
        If more than one place writes the same user — a sign-up handler and a scheduled sync, say — an older write can arrive
        after a newer one. Send <C>updatedAt</C>: when you read the state you&apos;re sending. We ignore a write older than
        the newest one we&apos;ve applied, and say so:
      </P>
      <Code>{`200 OK
{ "applied": false, "reason": "stale_write", "storedUpdatedAt": "2026-09-25T10:05:00.000Z", "user": { … } }`}</Code>
      <UL>
        <li>That&apos;s a success, not an error: what we hold is newer. Don&apos;t retry it.</li>
        <li>A write with the same <C>updatedAt</C> applies again, harmlessly.</li>
        <li>
          A write without <C>updatedAt</C> always applies, and doesn&apos;t move the bar. If several places write the same
          fields, send it from all of them.
        </li>
      </UL>

      <H2 id="batch">Many users at once</H2>
      <P>
        <C>POST /api/v2/users/batch</C> takes up to {V2_LIMITS.maxBatch} users — for a scheduled sync or a first import. Each
        item is a <C>userId</C> plus the same fields as a PATCH, and each is applied on its own: one bad item never fails the
        rest.
      </P>
      <Code title="Request">{`POST ${api}/batch

{
  "users": [
    { "userId": "user_123", "steps": { "create_project": "2026-09-25T10:02:00Z" } },
    { "userId": "user_456", "facts": { "projects": 0 }, "updatedAt": "2026-09-25T10:00:00Z" },
    { "userId": "user_789", "timezone": "Mars/Olympus" }
  ]
}`}</Code>
      <Code title="Response">{`200 OK
{
  "applied": 1,
  "ignored": 1,
  "failed": 1,
  "results": [
    { "index": 1, "userId": "user_456", "status": "ignored", "reason": "stale_write" },
    { "index": 2, "userId": "user_789", "status": "failed", "reason": "invalid",
      "fields": [{ "path": "timezone", "message": "not an IANA time zone, e.g. Europe/London" }] }
  ]
}`}</Code>
      <UL>
        <li>
          <C>results</C> lists only the items that weren&apos;t applied; <C>index</C> is the item&apos;s position in your
          array.
        </li>
        <li>
          <C>ignored</C> items need nothing (<C>stale_write</C> or <C>deleted_later</C>). <C>failed</C> ones weren&apos;t
          saved: <C>invalid</C> lists what was wrong in <C>fields</C> — fix and resend — and <C>internal_error</C> is safe to
          resend.
        </li>
        <li>
          The request itself fails with <C>400</C> only when the body isn&apos;t <C>{`{"users": [...]}`}</C> with 1–
          {V2_LIMITS.maxBatch} items.
        </li>
        <li>A batch counts as one request against your rate limit.</li>
        <li>
          In the SDK, <C>yg.users.batch(items)</C> takes any number of users and sends them {V2_LIMITS.maxBatch} at a time.
          It returns the combined result and logs failed items in one warning; pass <C>{`{ throwOnItemError: true }`}</C> to
          throw instead.
        </li>
      </UL>

      <H2 id="get">Reading a user back</H2>
      <P>
        <C>{"GET /api/v2/users/{userId}"}</C> returns the state we hold, plus what YouGrow decided: the journeys
        they&apos;re in and any opt-outs. It answers <C>404</C> when we don&apos;t hold them — never sent, or deleted. In
        the SDK, <C>yg.users.get(id)</C> returns <C>null</C> then.
      </P>
      <Code>{`curl -u "$YOUGROW_KEY_ID:$YOUGROW_SECRET" "${api}/user_123"

{
  "userId": "user_123",
  "email": "alex@example.com",
  "firstName": "Alex",
  "lastName": null,
  "timezone": "Europe/London",
  "locale": "en-GB",
  "signedUpAt": "2026-09-25T09:30:00.000Z",
  "consent": "soft_opt_in",
  "subscribed": true,
  "excluded": null,
  "steps": { "create_project": "2026-09-25T10:02:00.000Z" },
  "facts": { "projects": 1 },
  "traits": { "plan": "pro" },
  "updatedAt": "2026-09-25T10:05:00.000Z",
  "enrolments": [{ "journeyId": "lcj_4f8a2c", "status": "active", "mode": "live", "enrolledAt": "2026-09-25T09:30:05.000Z" }],
  "optOuts": []
}`}</Code>
      <UL>
        <li>Timestamps come back in UTC.</li>
        <li>
          <C>enrolments</C>: each journey they&apos;re in or have been through — its <C>status</C> (<C>active</C>,{" "}
          <C>completed</C> or <C>exited</C>) and <C>mode</C> (<C>test</C>, <C>shadow</C> or <C>live</C>).
        </li>
        <li>
          <C>optOuts</C>: unsubscribes made in YouGrow&apos;s emails, e.g.{" "}
          <C>{`{"scope": "category", "category": "onboarding", "at": "…"}`}</C>. They hold whatever you send.
        </li>
      </UL>

      <H2 id="rules">Rules that keep it safe</H2>
      <UL>
        <li>
          <strong>Server-side only.</strong> The secret authenticates every request.
        </li>
        <li>
          <strong>Await every call.</strong> In a serverless function (Cloud Functions, Lambda, Vercel), work left running
          after it returns may never finish. The SDK sends each call straight away — there&apos;s no queue to flush.
        </li>
        <li>
          <strong>Never block your own flows.</strong> Catch and log errors: if YouGrow is unreachable, your user should
          still sign up. Writes are idempotent, so a retry later is safe.
        </li>
        <li>
          <strong>Retry what&apos;s worth retrying:</strong> network errors, <C>429</C> (after <C>Retry-After</C>) and{" "}
          <C>5xx</C>, with backoff. Don&apos;t retry a <C>400</C> — fix the payload. The SDK retries for you (3 times by
          default).
        </li>
        <li>
          <strong>Timestamps include a timezone:</strong> <C>2026-09-25T10:00:00Z</C>, or <C>new Date().toISOString()</C>.
        </li>
        <li>
          <strong>The SDK needs a Node runtime.</strong> On an edge runtime (Vercel Edge Functions, Next.js middleware,
          Cloudflare Workers), call the API with <C>fetch</C> as above — it&apos;s plain HTTPS.
        </li>
      </UL>

      <H2 id="reference">Reference</H2>
      <H3>Fields</H3>
      <P>
        The body of a PATCH, and of each batch item (plus <C>userId</C>). Every field is optional.
      </P>
      <Fields rows={USER_FIELDS.map((f) => [f.name, f.type, codeText(f.notes)])} />
      <P>{codeText(`\`userId\` (in the URL, or on a batch item): ${USER_ID_NOTES}`)}</P>

      <H3>Responses</H3>
      <Fields
        rows={[
          ["200 applied: true", "", <>Saved. <C>user</C> is the state we now hold.</>],
          ["200 applied: false", "", <>Skipped — we hold something newer: <C>stale_write</C> (older than the stored <C>updatedAt</C>, given as <C>storedUpdatedAt</C>) or <C>deleted_later</C> (older than a later DELETE). Nothing to fix; don&apos;t retry.</>],
          ["204", "", "DELETE: erased, or nothing to erase."],
          ["400 invalid", "", <>The body isn&apos;t valid, or has a field we don&apos;t know — or the <C>userId</C> in the URL isn&apos;t: <C>fields</C> lists each problem as a <C>path</C> and a <C>message</C>. Fix it; don&apos;t retry it as it is.</>],
          ["400 invalid_json", "", "The body isn't JSON."],
          ["401 unauthorized", "", "The key id or secret is missing or wrong, or the connection was revoked."],
          ["404 not_found", "", "GET: we don't hold that user. Events: send the user's state first."],
          ["404 api_disabled", "", "API v2 isn't switched on for this YouGrow."],
          ["413 body_too_large", "", `The body is over ${kb} KB.`],
          ["429 rate_limited", "", <>Too many requests: wait <C>Retry-After</C> seconds, then retry.</>],
          ["5xx", "", <>Something failed on our side: <C>500 internal</C>, or <C>503 unavailable</C> with <C>Retry-After</C>. Retry with backoff — writes are idempotent.</>],
        ]}
      />
      <P>
        A skipped write is a <C>200</C>, not a <C>409</C>: we already hold something newer, so there&apos;s nothing for you
        to fix.
      </P>

      <H3>Limits</H3>
      <UL>
        <li>
          600 requests a minute and 20,000 an hour, per key. A batch counts as one request. Over that: <C>429</C> with{" "}
          <C>Retry-After</C>.
        </li>
        <li>
          {kb} KB per request body, and {V2_LIMITS.maxBatch} users per batch.
        </li>
        <li>
          Per user: at most {V2_LIMITS.maxSteps} steps, {V2_LIMITS.maxFacts} facts and {V2_LIMITS.maxTraits} traits.
        </li>
      </UL>

      <H3>OpenAPI</H3>
      <P>
        Every endpoint, field and response is in the OpenAPI 3.1 spec at{" "}
        <a className="underline" href="/developers/openapi.json">
          /developers/openapi.json
        </a>{" "}
        — browse it in the{" "}
        <Link className="underline" href="/developers/api">
          API reference
        </Link>
        , or load it into your own tools. JSON Schemas for each body are listed on the{" "}
        <Link className="underline" href="/developers#agents">
          overview
        </Link>
        .
      </P>
    </article>
  );
}
