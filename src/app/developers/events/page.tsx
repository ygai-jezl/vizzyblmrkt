import Link from "next/link";
import { C, Code, Fields, H1, H2, H3, Lead, Note, OL, P, UL } from "@/components/developers/Doc";
import { docsOrigin } from "@/lib/developers/flags";

export default function EventsDocs() {
  const origin = docsOrigin();
  const url = `${origin}/api/v1/events`;
  return (
    <article>
      <H1>Sending events</H1>
      <Lead>
        Your server tells YouGrow what your users do — who signed up, and which onboarding steps they&apos;ve completed.
        Sign-ups start journeys; steps decide which email each person gets next. This page shows exactly where those calls
        go in your code, and how to make them.
      </Lead>
      <Note>
        <strong>Only sign-ups are required</strong> for a journey to run. Onboarding steps make it personal. Your
        product&apos;s <strong>Integration guide</strong> (Products → your product) lists these for your own code, with file
        pointers — and a <strong>Copy prompt</strong> button that hands the whole job to your coding agent.
      </Note>

      <H2 id="setup">Before you start</H2>
      <OL>
        <li>
          In YouGrow, <strong>Products → Connect a product</strong> gives you a <strong>key id</strong> (public) and a{" "}
          <strong>secret</strong> (shown once).
        </li>
        <li>
          Put both in your <strong>server&apos;s</strong> environment or secret manager as <C>YOUGROW_KEY_ID</C> and{" "}
          <C>YOUGROW_SECRET</C>. Never in source control, a browser or a mobile app — anyone with the secret can send
          events as your product.
        </li>
        <li>
          Add the small helper below (or the Node SDK). Every event goes to <C>{url}</C> as a signed <C>POST</C>.
        </li>
      </OL>

      <H3>The helper: sign and send (Node, no dependencies)</H3>
      <Code title="yougrow.ts">{`import { createHmac, randomUUID } from "node:crypto";

const URL = "${url}";

/** Send up to 100 messages. Throws on an error response — call it in the background (see "Rules"). */
export async function sendEvents(batch: object[]) {
  const body = JSON.stringify({ batch });                       // sign EXACTLY the bytes you send
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac("sha256", process.env.YOUGROW_SECRET!).update(\`events:\${ts}.\${body}\`).digest("hex");
  const res = await fetch(URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-yougrow-key-id": process.env.YOUGROW_KEY_ID!,
      "x-yougrow-timestamp": ts,
      "x-yougrow-signature": \`v1=\${sig}\`,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(\`YouGrow \${res.status}: \${await res.text()}\`);
  return res.json(); // { accepted, duplicates, rejected: [...] }
}

export const newId = () => randomUUID();`}</Code>

      <H3>The same in Python</H3>
      <Code title="yougrow.py">{`import hashlib, hmac, json, os, time
import requests

URL = "${url}"

def send_events(batch):
    body = json.dumps({"batch": batch}, separators=(",", ":"))  # sign EXACTLY the bytes you send
    ts = str(int(time.time()))
    sig = hmac.new(os.environ["YOUGROW_SECRET"].encode(), f"events:{ts}.{body}".encode(), hashlib.sha256).hexdigest()
    r = requests.post(URL, data=body, timeout=10, headers={   # data=, not json= (that would re-serialise)
        "Content-Type": "application/json",
        "X-YouGrow-Key-Id": os.environ["YOUGROW_KEY_ID"],
        "X-YouGrow-Timestamp": ts,
        "X-YouGrow-Signature": f"v1={sig}",
    })
    r.raise_for_status()
    return r.json()`}</Code>

      <H3>Or the Node SDK</H3>
      <P>
        <C>@yougrowai/node</C> adds batching, retries and helpers. It&apos;s pre-release (not yet on npm); the helper above does
        the same job in any codebase today.
      </P>
      <Code>{`import { YouGrow } from "@yougrowai/node";
const yg = new YouGrow({ keyId: process.env.YOUGROW_KEY_ID!, secret: process.env.YOUGROW_SECRET! });`}</Code>

      <H2 id="signups">1. Send sign-ups — required</H2>
      <H3>What</H3>
      <P>
        When someone creates an account, send two messages together: an <C>identify</C> saying who they are, and a{" "}
        <C>track</C> of <C>user.signed_up</C>.
      </P>
      <H3>Where in your code</H3>
      <P>
        The one place your server creates a new user — <strong>after</strong> the account exists. Wherever that is in
        your stack, for example:
      </P>
      <UL>
        <li>right after the insert in your own sign-up / registration handler;</li>
        <li>
          a Firebase Auth <C>onCreate</C> trigger, a Supabase or database trigger on your users table, an Auth0
          post-registration action, NextAuth&apos;s <C>createUser</C> event, or a Django <C>post_save</C> signal on your
          user model.
        </li>
      </UL>
      <P>Not in the browser, and not on every login — once per new account.</P>
      <H3>How</H3>
      <Code title="In your sign-up handler (Node)">{`import { sendEvents, newId } from "./yougrow";

// after the user is created…
const now = new Date().toISOString();
sendEvents([
  {
    type: "identify",
    messageId: newId(),
    userId: user.id,                       // YOUR id for this user — use it everywhere
    timestamp: now,
    traits: {
      email: user.email,
      firstName: user.firstName,
      timezone: user.timezone ?? "Europe/London",   // IANA name — see below
      plan: user.plan,                     // any other attributes journeys can branch on
    },
    consent: { basis: "soft_opt_in" },     // your legal basis for marketing email
  },
  { type: "track", messageId: newId(), userId: user.id, timestamp: now, event: "user.signed_up" },
]).catch((err) => console.error("YouGrow sign-up event failed", err)); // never block sign-up`}</Code>
      <Code title="With the SDK in a serverless function (e.g. Firebase Auth onCreate)">{`export const yougrowSignup = functions.auth.user().onCreate(async (user) => {
  const yg = new YouGrow({ keyId: process.env.YOUGROW_KEY_ID!, secret: process.env.YOUGROW_SECRET!, flushIntervalMs: 0 });
  yg.identify({ userId: user.uid, traits: { email: user.email ?? null, firstName: user.displayName?.split(" ")[0] ?? null } });
  yg.track({ userId: user.uid, event: "user.signed_up" });
  await yg.flush();                        // serverless: flush BEFORE returning, or the send may never happen
});`}</Code>
      <H3>Timezone</H3>
      <P>
        Emails go out in each person&apos;s morning, so send their IANA timezone (e.g. <C>America/New_York</C>). If you
        don&apos;t store one, capture it in the browser at sign-up with{" "}
        <C>Intl.DateTimeFormat().resolvedOptions().timeZone</C> and pass it to your server. Without it we use your
        connection&apos;s default timezone.
      </P>
      <H3>What happens on our side</H3>
      <P>
        We create the person&apos;s profile (email, name, timezone, consent), and <C>user.signed_up</C> enrols them in every
        published journey that starts on sign-up — the welcome email and everything after follow. Sign-ups older than a
        journey&apos;s limit (72 hours by default) don&apos;t enrol, so importing past users won&apos;t email them all.
      </P>
      <H3>Check it works</H3>
      <P>
        Sign up a test account, then open <strong>Products → your product → Events</strong>: the <C>identify</C> and{" "}
        <C>user.signed_up</C> appear within seconds. Rejected messages show their reason there too.
      </P>

      <H2 id="steps">2. Report onboarding steps — personalisation</H2>
      <H3>What</H3>
      <P>
        Each time a user completes one of your onboarding steps, send <C>onboarding.step_completed</C> with the step&apos;s
        id. Use the exact ids from your product&apos;s <strong>Catalog</strong> (e.g. <C>create_project</C>,{" "}
        <C>invite_team</C>). When every step is done you can also send <C>onboarding.completed</C>.
      </P>
      <H3>Where in your code — two ways</H3>
      <P>
        Send it <strong>the moment the step becomes true</strong>. Your Integration guide says which way fits each step:
      </P>
      <P>
        <strong>A. At a clear server moment</strong> — the step is a thing your server does: a project is created, a job
        finishes, an integration is connected. Add the call right after it succeeds:
      </P>
      <Code title="e.g. in your create-project handler">{`await db.projects.insert(project);
sendEvents([{
  type: "track", messageId: newId(), userId: user.id, timestamp: new Date().toISOString(),
  event: "onboarding.step_completed", properties: { step: "create_project" },
}]).catch((err) => console.error("YouGrow step event failed", err));`}</Code>
      <P>
        <strong>B. From a scheduled check</strong> — the step is a <em>state</em> rather than a moment (&ldquo;has at least
        3 competitors&rdquo;, &ldquo;has invited a teammate&rdquo;), or it&apos;s only worked out in the browser today. Run a
        small job every 15 minutes or so that looks at recent users and reports what&apos;s now true. Give each event a{" "}
        <strong>fixed <C>messageId</C></strong> — then repeats are ignored and the job can run as often as you like:
      </P>
      <Code title="e.g. a job every 15 minutes">{`const users = await db.users.createdInLastDays(14);
const batch = [];
for (const u of users) {
  if (await db.competitors.countConfirmed(u.id) >= 3) {
    batch.push({
      type: "track",
      messageId: \`\${u.id}:step:confirm_competitors\`,   // the same every run → counted once
      userId: u.id, timestamp: new Date().toISOString(),
      event: "onboarding.step_completed", properties: { step: "confirm_competitors" },
    });
  }
}
for (let i = 0; i < batch.length; i += 100) await sendEvents(batch.slice(i, i + 100));`}</Code>
      <H3>What happens on our side</H3>
      <P>
        We mark the step done on the person&apos;s profile. Journeys branch on it — someone who&apos;s created a project is
        nudged towards the next step instead, and people who&apos;ve finished get education instead of reminders — and the
        checklist in your emails ticks it off.
      </P>
      <H3>And the context endpoint?</H3>
      <P>
        Events keep us up to date between emails; your{" "}
        <Link className="underline" href="/developers/context-endpoint">
          context endpoint
        </Link>{" "}
        is the final, live check just before each email. Report the same step ids in both. If you skip step events, journeys
        still send — but everyone takes the reminder branch, and people can be nudged to do things they&apos;ve already done.
      </P>

      <H2 id="other">3. Deletion and email preferences — compliance</H2>
      <Fields
        rows={[
          ["user.deleted", "track", "When an account is erased (after any grace period you have). We delete the person's profile and history. While deletion is pending, return exit from your context endpoint so they get no more lifecycle email."],
          ["email_preferences.updated", "track", <>When someone changes email preferences in your product: <C>{`properties: { category: "onboarding", subscribed: false }`}</C>. Unsubscribes made in our emails come back to you as a <Link className="underline" href="/developers/webhooks">webhook</Link>.</>],
        ]}
      />
      <P>Any other event name (lower-case, dot-separated, e.g. <C>report.exported</C>) is recorded as a milestone journeys can branch on.</P>

      <H2 id="rules">Rules that keep it safe</H2>
      <UL>
        <li><strong>Server-side only.</strong> The secret signs every request.</li>
        <li>
          <strong>Never block your own flows.</strong> Send in the background and catch errors — if YouGrow is unreachable,
          your user should still sign up. Retry later if you like; duplicates are ignored.
        </li>
        <li><strong>Serverless (Cloud Functions, Lambda, edge):</strong> await the send (or <C>yg.flush()</C>) before your function returns.</li>
        <li><strong>A unique <C>messageId</C> per event</strong> — random for one-off events, fixed for scheduled checks.</li>
        <li><strong>Timestamps must include a timezone</strong> (<C>2026-09-23T10:00:00Z</C>), and be no more than a day in the future.</li>
        <li>Up to 100 messages and 512 KB per request.</li>
      </UL>

      <H2 id="reference">Reference</H2>
      <H3>Headers</H3>
      <Code>{`POST ${url}
Content-Type: application/json
X-YouGrow-Key-Id:    <your key id>
X-YouGrow-Timestamp: <unix seconds>
X-YouGrow-Signature: v1=<hex HMAC-SHA256(secret, "events:" + timestamp + "." + rawBody)>`}</Code>
      <P>
        Requests more than five minutes from our clock are refused. See{" "}
        <Link className="underline" href="/developers/security#signing-events">signing</Link> for rotation and test vectors.
      </P>
      <H3>identify</H3>
      <Fields
        rows={[
          ["messageId", "string", "Unique per message, ≤ 128 chars. A repeat is counted as a duplicate, not a new event."],
          ["userId", "string", "Your id for the user, ≤ 256 chars."],
          ["timestamp", "string", "ISO 8601 with a timezone."],
          ["traits", "object", <>Up to 50 keys (letters, digits, <C>_</C>, <C>-</C>; start with a letter). Values: string (≤ 500), number, boolean or null. <C>email</C>, <C>firstName</C>/<C>first_name</C>, <C>lastName</C>/<C>last_name</C>, <C>timezone</C> (IANA) and <C>locale</C> have special meaning; everything else is a trait journeys can branch on.</>],
          ["consent.basis", "string", <><C>consent</C>, <C>soft_opt_in</C>, <C>corporate_subscriber</C> or <C>none</C>. Service emails (like a welcome) don&apos;t need one. <C>corporate_subscriber</C> is treated as <C>none</C> for free-mail addresses (gmail.com, …).</>],
          ["consent.source", "string?", "Where it was captured, ≤ 64 chars (for your audit trail)."],
        ]}
      />
      <H3>track</H3>
      <Fields
        rows={[
          ["event", "string", "Lower-case, dot-separated, ≤ 80 chars."],
          ["properties", "object", "Anything useful, ≤ 4 KB serialised."],
          ["traits", "object?", "Optional trait updates, same rules as identify."],
        ]}
      />
      <H3>Responses</H3>
      <Code>{`202 Accepted
{ "accepted": 2, "duplicates": 0, "rejected": [ { "index": 3, "messageId": "…", "reason": "timestamp_in_future" } ] }`}</Code>
      <P>A batch is accepted message by message: one bad message doesn&apos;t fail the others.</P>
      <Fields
        rows={[
          ["400 invalid_json / invalid_batch", "", "The body isn't valid JSON, or isn't { batch: [...] } with 1+ messages."],
          ["401 missing_signature / bad_signature / stale_timestamp / unknown_key", "", "Check the headers, the secret, that you signed the exact bytes you sent, and your server clock."],
          ["413 body_too_large / batch_too_large", "", "Over 512 KB, or more than 100 messages."],
          ["429 rate_limited", "", "Slow down; retry after the Retry-After header (seconds)."],
          ["5xx", "", "Retry with backoff — your messageIds make retries safe."],
        ]}
      />
    </article>
  );
}
