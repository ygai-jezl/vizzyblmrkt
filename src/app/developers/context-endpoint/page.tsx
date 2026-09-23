import Link from "next/link";
import { C, Code, Fields, H1, H2, H3, Lead, Note, OL, P, UL } from "@/components/developers/Doc";

export default function ContextEndpointDocs() {
  return (
    <article>
      <H1>The context endpoint</H1>
      <Lead>
        Just before YouGrow emails one of your users, it asks your server for that person&apos;s current state. Your
        answer decides which branch of the journey they take, fills in their checklist and next step, and supplies
        the true facts an email may mention.
      </Lead>
      <Note>
        Why ask, rather than rely on events alone? Events tell us what happened; the context endpoint tells us what&apos;s{" "}
        <em>true right now</em> — including numbers only your product knows. It&apos;s also how your product keeps the
        final say: you can hold or stop email for anyone, at the moment it would be sent.
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
  "requestId": "b5c1e6d2-…"
}`}</Code>
      <Fields
        rows={[
          ["userId", "string", "Your own id for the user — the userId you send in events."],
          ["purpose", "string", <><C>send</C>, <C>prepare</C> or <C>test</C>. You can answer them all the same way.</>],
          ["journeyId / nodeId", "string?", "Which journey and step is asking — useful in your logs."],
          ["requestId", "string", <>Unique per request; it&apos;s also the token&apos;s <C>jti</C>.</>],
        ]}
      />

      <H2 id="response">The response</H2>
      <P>
        Reply <C>200</C> with JSON — at most 64 KB, within your configured timeout (5 seconds at most). Only{" "}
        <C>asOf</C> is required; send what you have.
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
          ["id", "string", <>Your step id — the same ids as your catalog and <C>onboarding.step_completed</C> events. Lower-case letters, digits, <C>_</C>, <C>-</C>.</>],
          ["label", "string", "What the user sees, ≤ 120 chars."],
          ["done", "boolean", "Whether it's done now. This overrides what events said, so journeys follow the live state."],
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
          ["value", "number | string | boolean", "The value (strings ≤ 200). Journeys can branch on it: fact.<id>."],
          ["unit", "string?", <>E.g. <C>%</C>, ≤ 20 chars.</>],
          ["display", "string?", <>How to show it, e.g. <C>12%</C>.</>],
          ["source / observedAt", "string?", "Where it came from and when — shown to your team when they review drafts."],
        ]}
      />

      <H3>insights — sentences we may quote (up to 20)</H3>
      <Fields
        rows={[
          ["id", "string", "Stable id; each insight is used at most once per user."],
          ["sentence", "string", <>A complete, <strong>true</strong> sentence, ≤ 300 chars. This is the only place numbers about the user appear in an email.</>],
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
          ["consent", "object?", <><C>basis</C> (<C>consent</C>, <C>soft_opt_in</C>, <C>corporate_subscriber</C>, <C>none</C>) and optional <C>categories</C> (e.g. <C>{`{"onboarding": false}`}</C>). Overrides what events said.</>],
          ["hold", "object?", <><C>{`{ "reason": "…", "until": "<ISO time>" }`}</C> — don&apos;t email yet (e.g. their data is still loading). We check again at <C>until</C> — 6 hours if you don&apos;t say, never more than 24 hours.</>],
          ["exit", "object?", <><C>{`{ "reason": "…" }`}</C> — stop all lifecycle email for this user: staff accounts, invited team members, accounts pending deletion, anyone who shouldn&apos;t get it.</>],
        ]}
      />

      <H2 id="failures">Failures and timeouts</H2>
      <UL>
        <li>
          If your endpoint errors, times out, or returns something invalid, the email still goes out using what events
          told us — without the insight block — and conditions use the steps from your events. Unknown data never
          matches a branch, so people fall to each branch&apos;s safe default.
        </li>
        <li>Links that aren&apos;t https on your allowed link domains are removed; the rest of the response is kept.</li>
        <li>
          Your connection shows the last success and the last error. Repeated failures are worth fixing quickly: the
          journey stops being able to see your live data.
        </li>
      </UL>

      <H2 id="example">A complete example (Node)</H2>
      <Code title="Express">{`import express from "express";
import { createVerifier, contextResponse } from "@yougrow/node/server";

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
