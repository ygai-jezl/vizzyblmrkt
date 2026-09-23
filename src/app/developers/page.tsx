import Link from "next/link";
import { C, Code, H1, H2, Lead, Note, OL, P, UL } from "@/components/developers/Doc";
import { docsOrigin } from "@/lib/developers/flags";

export default function DevelopersHome() {
  const origin = docsOrigin();
  return (
    <article>
      <H1>Connect your product</H1>
      <Lead>
        Lifecycle journeys email each of your users based on where they are in your product — nudging people who
        haven&apos;t finished getting started, and teaching the ones who have. To do that, your product and YouGrow
        exchange three things.
      </Lead>

      <H2 id="how">How it works</H2>
      <Code title="The three parts of a connection">{`Your product ── events (signed with your secret) ──────────▶ ${origin}/api/v1/events
            ◀── context request (signed by YouGrow) ──── before each email, about one user
            ──── steps, facts, insights ───────────────▶
            ◀── webhooks (signed by YouGrow) ─────────── e.g. "this user unsubscribed"`}</Code>
      <UL>
        <li>
          <strong>Events</strong> — your server tells us what users do: who signed up, which onboarding steps
          they&apos;ve completed, and other milestones. Events create each user&apos;s profile and start journeys.{" "}
          <Link className="underline" href="/developers/events">
            Sending events →
          </Link>
        </li>
        <li>
          <strong>The context endpoint</strong> — just before we email someone, we ask your server for their current
          state: which steps are done, what to do next, and true facts about their account to mention.{" "}
          <Link className="underline" href="/developers/context-endpoint">
            Context endpoint →
          </Link>
        </li>
        <li>
          <strong>Webhooks</strong> — we tell your server about changes it should mirror, like an unsubscribe.{" "}
          <Link className="underline" href="/developers/webhooks">
            Webhooks →
          </Link>
        </li>
      </UL>

      <H2 id="start">Getting started</H2>
      <OL>
        <li>
          In YouGrow, go to <strong>Products → Connect a product</strong>. You get a <strong>key id</strong> (public)
          and a <strong>secret</strong> (shown once — store it in your server&apos;s secret manager, never in code or
          the browser).
        </li>
        <li>
          Optional but recommended: open <strong>Learn from repo</strong> on the connection. We read your code
          (read-only — we never change it) and propose your catalog: your onboarding steps and how each is done, the
          events you can send, and the facts you can report. You review and keep what&apos;s right. Your
          connection&apos;s <strong>Integration guide</strong> then lists exactly what to build.
        </li>
        <li>
          Send <C>identify</C> and <C>user.signed_up</C> when someone signs up, and{" "}
          <C>onboarding.step_completed</C> as they complete each step. Watch them arrive in the connection&apos;s{" "}
          <strong>Events</strong> tab.
        </li>
        <li>
          Build your context endpoint, add its URL in the connection&apos;s <strong>Settings</strong>, and press{" "}
          <strong>Test connection</strong>.
        </li>
        <li>
          Build a journey, publish it in <strong>test</strong> mode (only your listed test users get email), then
          shadow, then live.
        </li>
      </OL>

      <Note>
        Use separate connections for separate environments — for example <em>Acme (staging)</em> for your staging app
        and <em>Acme (production)</em> for your live one. Each has its own key and secret. Once a journey works on
        staging, <strong>Copy to…</strong> puts it on production as a draft.
      </Note>

      <H2 id="sdk">The Node SDK</H2>
      <P>
        <C>@yougrow/node</C> handles signing, batching and retries for events, and verifies our requests for your
        endpoints. It&apos;s pre-release (not yet on npm); every part of the protocol is documented here, so any
        language works.
      </P>
      <Code title="Node">{`import { YouGrow } from "@yougrow/node";
import { createVerifier, contextResponse } from "@yougrow/node/server";

const yg = new YouGrow({ keyId: process.env.YOUGROW_KEY_ID!, secret: process.env.YOUGROW_SECRET! });
const verifier = createVerifier({ keyId: process.env.YOUGROW_KEY_ID! });`}</Code>
    </article>
  );
}
