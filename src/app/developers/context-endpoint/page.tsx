import Link from "next/link";
import { C, Code, Fields, H1, H2, H3, Lead, Note, OL, P, UL } from "@/components/developers/Doc";
import { isDateFactsEnabled } from "@/lib/connect/v2/flags";

export default function ContextEndpointDocs() {
  return (
    <article>
      <H1>The context endpoint</H1>
      <Lead>
        When you set one, YouGrow asks your server about one user just before it emails them. It&apos;s how an email tells
        someone something true about their own results — a score, a count, a finished job, how they compare — in your
        words, and how your product keeps the final say: hold or stop an email at the moment it would go.
      </Lead>
      <Note>
        <strong>What you lose without one.</strong> Journeys still run on the state you{" "}
        <Link className="underline" href="/developers/users">
          send
        </Link>
        , and a template can print a bare fact you&apos;ve sent. But no email can say what a person&apos;s own numbers mean
        — an insight sentence such as &ldquo;Your last report found 3 issues, down from 9 last week&rdquo; — because only
        your product can write it and keep it true. Nor can you hold an email until there&apos;s something to say (while a
        first result is still being produced), or stop one at the last moment. Build it if your emails should show people
        their results; skip it only if they&apos;ll only ever nudge steps.{" "}
        <strong>Coding agents:</strong> don&apos;t decide this for the product owner — say what they&apos;d lose, and ask.
      </Note>

      <H2 id="setup">What you need in place</H2>
      <OL>
        <li>
          An <strong>HTTPS endpoint</strong> on your server that accepts <C>POST</C> — on the public internet, port 443,
          answering directly (redirects aren&apos;t followed).
        </li>
        <li>
          <strong>Request verification</strong> with YouGrow&apos;s public keys — see{" "}
          <Link className="underline" href="/developers/security#verifying">
            verifying our requests
          </Link>
          . Reject anything that doesn&apos;t verify with <C>401</C>.
        </li>
        <li>
          A lookup of <strong>one user</strong> by your own user id: their onboarding steps, the next step, facts about
          their account, and any reason not to email them.
        </li>
        <li>
          The URL saved in your connection&apos;s <strong>Settings → Context endpoint</strong>, and your app&apos;s domain
          in <strong>allowed link domains</strong> (links anywhere else are removed).
        </li>
        <li>
          A green <strong>Test connection</strong> on the connection page — it calls your endpoint for a test user and
          shows exactly what we understood.
        </li>
      </OL>

      <H2 id="when">When we call it</H2>
      <P>Only while a context endpoint is set and switched on in your connection&apos;s Settings.</P>
      <Fields
        rows={[
          ["send", "", "When a journey is about to act for this user — take a branch or send an email. This is the call that matters most."],
          ["prepare", "", "About 12 hours before an email with a personalised line, so a draft can be written from your facts and reviewed by your team."],
          ["test", "", "From Test connection in YouGrow."],
        ]}
      />
      <P>
        Expect one call per step of a journey per user — a handful per person over a week-long sequence, never a
        stream. If your endpoint is down, journeys keep working (see <a className="underline" href="#failures">failures</a>).
      </P>

      <H2 id="request">The request</H2>
      <Code>{`POST https://api.your-app.com/yougrow/context
Content-Type: application/json
Authorization: Bearer <JWT signed by YouGrow>
X-YouGrow-Key-Id: <your key id>

{
  "userId": "user_123",
  "purpose": "send",
  "journeyId": "lcj_…",
  "nodeId": "cond_1",
  "entity": { "id": "proj_42", "kind": "project" },
  "requestId": "b5c1e6d2-…"
}`}</Code>
      <Fields
        rows={[
          ["userId", "string", "Your own id for the user — the userId you use in the API."],
          ["purpose", "string", <><C>send</C>, <C>prepare</C> or <C>test</C>. You can answer them all the same way.</>],
          ["journeyId / nodeId", "string?", "Which journey and step is asking — useful in your logs."],
          [
            "entity",
            "object?",
            <>
              When the email is about one of the user&apos;s{" "}
              <Link className="underline" href="/developers/users#entities">
                entities
              </Link>{" "}
              (a workspace, a project, a brand — whatever they have several of): its <C>id</C> and <C>kind</C>, as you sent
              them. Answer for that one: its steps, facts and insights. Facts are matched by id, so the person&apos;s own
              facts (the ones you don&apos;t keep per entity) can come back in the same list. Absent: answer for the person.
            </>,
          ],
          ["requestId", "string", <>Unique per request; it&apos;s also the token&apos;s <C>jti</C>.</>],
        ]}
      />

      <H2 id="response">The response</H2>
      <P>
        Reply <C>200</C> with JSON — at most 64 KB, within your configured timeout (2 seconds by default, 5 at most).
        Only <C>asOf</C> is required; send what you have.
      </P>
      <Code>{`{
  "asOf": "2026-09-23T10:00:00Z",
  "steps": [
    { "id": "create_brand", "label": "Add your brand",       "done": true,  "doneAt": "2026-09-22T09:12:00Z" },
    { "id": "run_audit",    "label": "Run your first audit", "done": false, "url": "https://app.acme.com/audits/new" }
  ],
  "nextStep": { "id": "run_audit", "label": "Run your first audit", "url": "https://app.acme.com/audits/new" },
  "facts": [
    { "id": "share_of_voice", "label": "Share of voice", "value": 12, "unit": "%", "source": "Daily snapshot" },
    { "id": "competitors_named", "label": "Competitors named instead of you", "value": 3 }
  ],
  "insights": [
    { "id": "competitors_named", "sentence": "ChatGPT named 3 competitors in answers about your category, but not you.",
      "factIds": ["competitors_named"], "weight": 0.8, "supportsStep": "run_audit" }
  ],
  "consent": { "basis": "soft_opt_in", "categories": { "onboarding": true } }
}`}</Code>

      <H3>steps — the onboarding checklist (up to 20)</H3>
      <Fields
        rows={[
          ["id", "string", <>Your step id — the same ids as your catalog and the <C>steps</C> you send. Lower-case letters, digits, <C>_</C>, <C>-</C>.</>],
          ["label", "string", "What the user sees, ≤ 120 chars."],
          ["done", "boolean", "Whether it's done now. This overrides the steps you've sent, so journeys follow the live state."],
          ["doneAt", "string?", "When it was done (ISO 8601 with a timezone)."],
          ["url", "string?", "A deep link that completes the step — https, on your allowed link domains."],
          ["blocked", "string?", "If the user can't do this step yet, why (≤ 200 chars)."],
        ]}
      />
      <H3>nextStep</H3>
      <P>The one step to nudge towards (<C>id</C>, <C>label</C>, <C>url</C>) — usually the first step not done. It powers the &ldquo;next step&rdquo; button in emails. Omit it or send <C>null</C> when there&apos;s nothing to do.</P>

      <H3>facts — true numbers about this user (up to 50)</H3>
      <Fields
        rows={[
          ["id", "string", <>Stable id, ≤ 64 chars. List the ids you send in your catalog&apos;s <strong>Facts</strong> — Test connection warns about any it doesn&apos;t know.</>],
          ["label", "string", "What the number is, ≤ 120 chars."],
          ["value", "number | string | boolean", "The value (strings ≤ 200). Journeys can branch on it: fact.<id>. It overrides the value you've sent."],
          ["unit", "string?", <>E.g. <C>%</C>, ≤ 20 chars.</>],
          ["display", "string?", <>How to show it, e.g. <C>12%</C>.</>],
          ["source / observedAt", "string?", "Where it came from and when — shown to your team when they review drafts."],
        ]}
      />
      {isDateFactsEnabled() ? (
        <Note>
          <strong>Dates.</strong> A fact your catalog marks as a <strong>date</strong> (when someone was last active, when a
          trial ends) is text here too: ISO 8601 with a timezone (<C>2026-10-08T09:12:00Z</C>) or a plain day (
          <C>2026-10-08</C>). Journeys read it as days since, or until. Returning it here means an email due today knows
          about a change made today — someone who came back this morning isn&apos;t nudged — where the value you last sent
          could be a day old. One that isn&apos;t a date is ignored and the value you last sent is used; Test connection
          tells you.
        </Note>
      ) : null}

      <H3>insights — sentences we may quote (up to 20)</H3>
      <Fields
        rows={[
          ["id", "string", "Stable id; each insight is used at most once per user."],
          [
            "sentence",
            "string",
            <>
              A complete, <strong>true</strong> sentence, ≤ 300 chars — the only way an email says what someone&apos;s numbers
              mean. (A template can print a bare fact with <C>{"{{fact.<id>}}"}</C>; the sentence about it comes from here.)
            </>,
          ],
          ["factIds", "string[]", "The facts it's based on."],
          ["weight", "0–1", "How strong it is (default 0.5). Stronger insights are used first."],
          ["supportsStep", "string?", "A step id this insight encourages — preferred when that step is the next one."],
        ]}
      />
      <Note>
        <strong>Numbers only ever come from you.</strong> YouGrow may add a short, personal line next to your sentence
        (reviewed by your team first), but that line is checked to contain no numbers, links or names that aren&apos;t in
        your facts. If a sentence can&apos;t be backed by your data, leave it out.
      </Note>

      <H3>consent, hold and exit — your product has the final say</H3>
      <Fields
        rows={[
          ["consent", "object?", <><C>basis</C> (<C>consent</C>, <C>soft_opt_in</C>, <C>corporate_subscriber</C>, <C>none</C>) and optional <C>categories</C> (e.g. <C>{`{"onboarding": false}`}</C>). Overrides the consent you&apos;ve sent.</>],
          ["hold", "object?", <><C>{`{ "reason": "…", "until": "<ISO time>" }`}</C> — don&apos;t email yet (e.g. their data is still loading). We check again at <C>until</C> — 6 hours if you don&apos;t say, never more than 24 hours.</>],
          ["exit", "object?", <><C>{`{ "reason": "…" }`}</C> — stop all lifecycle email for this user: staff accounts, invited team members, accounts pending deletion, anyone who shouldn&apos;t get it. For people you know about in advance, <C>excluded</C> in their state does the same without an endpoint.</>],
        ]}
      />

      <H2 id="failures">Failures and timeouts</H2>
      <UL>
        <li>
          If your endpoint errors, times out, or returns something invalid, the email still goes out using the state
          you&apos;ve sent — without the insight block — and conditions use your stored steps and facts. Unknown data
          never matches a branch, so people fall to each branch&apos;s safe default.
        </li>
        <li>
          After 3 failures in a row we stop asking for 15 minutes and use the stored state; then we try again. So a slow
          or broken endpoint never holds up your journeys.
        </li>
        <li>Links that aren&apos;t https on your allowed link domains are removed; the rest of the response is kept.</li>
        <li>
          On a serverless platform, a cold start counts against your timeout too — see{" "}
          <Link className="underline" href="/developers/security#raw-body">
            reading the raw body
          </Link>{" "}
          for each framework, and keep the verifier at module scope.
        </li>
        <li>
          Your connection shows the last success and the last error. Repeated failures are worth fixing quickly: the
          journey stops being able to see your live data.
        </li>
      </UL>

      <H2 id="example">A complete example (Node)</H2>
      <Code title="Express">{`import express from "express";
import { createVerifier, contextResponse } from "@yougrowai/node/server";

const verifier = createVerifier({ keyId: process.env.YOUGROW_KEY_ID! });
const app = express();

// Verify against the RAW body — parse only after it checks out.
app.post("/yougrow/context", express.raw({ type: "application/json", limit: "16kb" }), async (req, res) => {
  const rawBody = req.body.toString("utf8");
  const v = await verifier.verify({ headers: req.headers, rawBody, direction: "context" });
  if (!v.ok) return res.status(401).json({ error: v.reason });

  const { userId } = JSON.parse(rawBody);
  const user = await db.users.find(userId);
  if (!user) return res.status(404).end();
  if (user.isStaff || user.pendingDeletion) {
    return res.type("json").send(contextResponse({ exit: { reason: "not a lifecycle recipient" } }));
  }

  const steps = [
    { id: "create_brand", label: "Add your brand", done: Boolean(user.brandId), url: "https://app.acme.com/brand/new" },
    { id: "run_audit", label: "Run your first audit", done: await db.audits.anyCompleted(userId), url: "https://app.acme.com/audits/new" },
  ];
  const sov = await db.metrics.latestShareOfVoice(userId); // null when there's no data yet
  res.type("json").send(
    contextResponse({
      steps,
      nextStep: steps.find((s) => !s.done) ?? null,
      facts: sov === null ? [] : [{ id: "share_of_voice", label: "Share of voice", value: sov, unit: "%" }],
      insights: sov === null ? [] : [{ id: "sov", sentence: \`AI answers mention you in \${sov}% of questions about your category.\`, factIds: ["share_of_voice"] }],
    }),
  );
});`}</Code>
      <P>
        Not using Node? Any JWT library works — the checks are listed in{" "}
        <Link className="underline" href="/developers/security#verifying">
          verifying our requests
        </Link>
        .
      </P>
    </article>
  );
}
