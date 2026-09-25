import Link from "next/link";
import { C, Code, H1, H2, Lead, Note, OL, P, UL } from "@/components/developers/Doc";
import { docsOrigin, SDK_DEFAULT_ORIGIN } from "@/lib/developers/flags";
import { SCHEMAS } from "@/lib/developers/schemas";

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
          Recommended: open <strong>Learn from repo</strong> on the connection and connect GitHub or GitLab — read-only,
          about a minute (<Link className="underline" href="/developers/connect-your-code">how connecting works</Link>). We
          read your code and propose your catalog: your onboarding steps and how each is done, the events you can send,
          and the facts you can report. You review and keep what&apos;s right. Your connection&apos;s{" "}
          <strong>Integration guide</strong> then lists exactly what to build, in priority order and pointing at your own
          files — with a <strong>Copy prompt</strong> button that hands the whole job to your coding agent (Claude Code,
          Cursor, …).
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
        <a className="underline" href="https://www.npmjs.com/package/@yougrowai/node" target="_blank" rel="noreferrer">
          <C>@yougrowai/node</C>
        </a>{" "}
        handles signing, batching and retries for events, and verifies our requests for your endpoints. Node 18 or later,
        no dependencies, from ES modules (<C>import</C>) or CommonJS (<C>require</C>, from 0.2.0). Every part of the
        protocol is documented here too, so any language works.
      </P>
      <Code title="Install">{`npm install @yougrowai/node`}</Code>
      <Code title="Node">{`import { YouGrow } from "@yougrowai/node";
import { createVerifier, contextResponse } from "@yougrowai/node/server";

const yg = new YouGrow({ keyId: process.env.YOUGROW_KEY_ID!, secret: process.env.YOUGROW_SECRET! });
const verifier = createVerifier({ keyId: process.env.YOUGROW_KEY_ID! });`}</Code>
      {origin !== SDK_DEFAULT_ORIGIN ? (
        <P>
          This YouGrow is at <C>{origin}</C>, and the SDK uses <C>{SDK_DEFAULT_ORIGIN}</C> unless told otherwise. Pass{" "}
          <C>{`origin: "${origin}"`}</C> to both (0.2.0 and later) — or, with earlier versions,{" "}
          <C>{`endpoint: "${origin}/api/v1/events"`}</C> to <C>YouGrow</C> and <C>{`issuer: "${origin}"`}</C> to{" "}
          <C>createVerifier</C>.
        </P>
      ) : null}
      <P>
        Short-lived code has to wait for the send: in a serverless function (Cloud Functions, Lambda, Vercel),{" "}
        <C>await yg.flush()</C> before it returns; in a script, <C>await yg.close()</C> before it exits. The SDK needs a
        Node runtime — edge runtimes (Vercel Edge Functions, Next.js middleware, Cloudflare Workers) aren&apos;t supported
        yet.
      </P>

      <H2 id="agents">For coding agents</H2>
      <P>
        Handing the integration to Claude Code, Cursor or another coding agent? Everything here is also plain Markdown,
        and the protocol is machine-readable:
      </P>
      <UL>
        <li>
          <a className="underline" href="/llms.txt">llms.txt</a> is the index, and{" "}
          <a className="underline" href="/developers/llms-full.txt">llms-full.txt</a> has every page in one file. Each page
          also has a <C>.md</C> twin, e.g. <a className="underline" href="/developers/events.md">/developers/events.md</a>.
        </li>
        <li>
          JSON Schemas, generated from the validators our API uses:{" "}
          {Object.entries(SCHEMAS).map(([name, s], i, all) => (
            <span key={name}>
              <a className="underline" href={`/developers/schema/${name}`}>
                {s.title.toLowerCase()}
              </a>
              {i < all.length - 1 ? ", " : "."}
            </span>
          ))}
        </li>
        <li>
          <a className="underline" href="/developers/test-vectors.json">Signing test vectors</a> for any language, and our
          public keys at <C>{`${origin}/.well-known/jwks.json`}</C>.
        </li>
      </UL>
      <Note>
        The contract is these docs, the schemas and the published <C>@yougrowai/node</C> package. YouGrow&apos;s own source
        code isn&apos;t: its main branch can be ahead of what&apos;s deployed.
      </Note>
    </article>
  );
}
