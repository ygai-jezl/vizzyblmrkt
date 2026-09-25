import Link from "next/link";
import { C, Code, H1, H2, Lead, Note, OL, P, UL } from "@/components/developers/Doc";
import { docsOrigin, SDK_DEFAULT_ORIGIN } from "@/lib/developers/flags";
import { SCHEMAS } from "@/lib/developers/schemas";

export default function DevelopersHome() {
  const origin = docsOrigin();
  const sdkOrigin = origin === SDK_DEFAULT_ORIGIN ? "" : `, origin: "${origin}"`;
  return (
    <article>
      <H1>Connect your product</H1>
      <Lead>
        Lifecycle journeys email each of your users based on where they are in your product — nudging people who
        haven&apos;t finished getting started, and teaching the ones who have. To do that, your server tells YouGrow about
        each user, and YouGrow does the rest.
      </Lead>
      <Note>
        <strong>Removed on 2026-09-25:</strong> API v1 (<C>POST /api/v1/events</C> and its HMAC signing). Use API v2 —{" "}
        <Link className="underline" href="/developers/users">
          sending users
        </Link>
        .
      </Note>

      <H2 id="how">How it works</H2>
      <Code title="The parts of a connection">{`Your product ── each user's state (HTTP Basic, your key) ──▶ PATCH ${origin}/api/v2/users/{userId}
            ◀── context request (signed by YouGrow) ────── optional: before an email, about one user
            ──── live steps, facts, insights ────────────▶
            ◀── webhooks (signed by YouGrow) ───────────── optional: e.g. "this user unsubscribed"`}</Code>
      <UL>
        <li>
          <strong>Your users&apos; state</strong> — your server tells us about each user: who they are, when they signed
          up, which onboarding steps they&apos;ve done, facts about their account, and whether they&apos;ve opted out. You
          send their current state; we keep it, and journeys decide who gets which email, and when.{" "}
          <Link className="underline" href="/developers/users">
            Sending users →
          </Link>
        </li>
        <li>
          <strong>The context endpoint (optional)</strong> — if some values change too fast to send, we can ask your server
          for them just before we email someone.{" "}
          <Link className="underline" href="/developers/context-endpoint">
            Context endpoint →
          </Link>
        </li>
        <li>
          <strong>Webhooks (optional)</strong> — we tell your server about changes it should mirror, like an unsubscribe.{" "}
          <Link className="underline" href="/developers/webhooks">
            Webhooks →
          </Link>
        </li>
      </UL>

      <H2 id="start">Getting started</H2>
      <OL>
        <li>
          In YouGrow, go to <strong>Products → Connect a product</strong>. You get a <strong>key id</strong> (public) and a{" "}
          <strong>secret</strong> (shown once — store it in your server&apos;s secret manager, never in code or the
          browser).
        </li>
        <li>
          Recommended: open <strong>Learn from repo</strong> on the connection and connect GitHub or GitLab — read-only,
          about a minute (<Link className="underline" href="/developers/connect-your-code">how connecting works</Link>). We
          read your code and propose your catalog: your onboarding steps and how each is done, and the facts you can report.
          You review and keep what&apos;s right. Your connection&apos;s <strong>Integration guide</strong> then lists exactly
          what to build, in priority order and pointing at your own files — with a <strong>Copy prompt</strong> button that
          hands the whole job to your coding agent (Claude Code, Cursor, …).
        </li>
        <li>
          When someone signs up, send their state: <C>{"PATCH /api/v2/users/{userId}"}</C> with <C>signedUpAt</C>,{" "}
          <C>email</C>, <C>firstName</C>, <C>timezone</C> and <C>consent</C>. Add <C>steps</C> as they get started. Watch the
          writes arrive in the connection&apos;s <strong>Events</strong> tab.
        </li>
        <li>
          Optional: build a context endpoint for values that change too fast to send, add its URL in the connection&apos;s{" "}
          <strong>Settings</strong>, and press <strong>Test connection</strong>.
        </li>
        <li>
          Build a journey, publish it in <strong>test</strong> mode (only your listed test users get email), then shadow,
          then live.
        </li>
      </OL>

      <Note>
        Use separate connections for separate environments — for example <em>Acme (staging)</em> for your staging app and{" "}
        <em>Acme (production)</em> for your live one. Each has its own key and secret. Once a journey works on staging,{" "}
        <strong>Copy to…</strong> puts it on production as a draft.
      </Note>

      <H2 id="sdk">The Node SDK</H2>
      <P>
        <a className="underline" href="https://www.npmjs.com/package/@yougrowai/node" target="_blank" rel="noreferrer">
          <C>@yougrowai/node</C>
        </a>{" "}
        sends your users&apos; state, retries what&apos;s safe to retry, splits big batches, and verifies our requests for
        your endpoints. Node 18 or later, no dependencies, from ES modules (<C>import</C>) or CommonJS (<C>require</C>).
        Version 0.3.0 is the first for API v2 — earlier versions sent v1 events. Every part of the API is documented here
        too, so any language works.
      </P>
      <Code title="Install">{`npm install @yougrowai/node`}</Code>
      <Code title="Node">{`import { YouGrow } from "@yougrowai/node";          // or: const { YouGrow } = require("@yougrowai/node");
import { createVerifier, contextResponse } from "@yougrowai/node/server";

const yg = new YouGrow({ keyId: process.env.YOUGROW_KEY_ID!, secret: process.env.YOUGROW_SECRET!${sdkOrigin} });

await yg.users.update("user_123", { signedUpAt: new Date().toISOString(), email: "alex@example.com" });
await yg.users.batch([{ userId: "user_123", steps: { create_project: new Date().toISOString() } }]); // any number
const alex = await yg.users.get("user_123");      // null if YouGrow doesn't hold them
await yg.users.delete("user_123");
await yg.events.track("user_123", "report.exported");

// For your context endpoint and webhooks:
const verifier = createVerifier({ keyId: process.env.YOUGROW_KEY_ID!${sdkOrigin} });`}</Code>
      {sdkOrigin ? (
        <P>
          This YouGrow is at <C>{origin}</C>, and the SDK uses <C>{SDK_DEFAULT_ORIGIN}</C> unless told otherwise — hence{" "}
          <C>origin</C> on both, or <C>origin: process.env.YOUGROW_ORIGIN</C>.
        </P>
      ) : null}
      <P>
        Every call is awaited and sent straight away — there&apos;s no queue, so nothing is lost when a serverless function
        returns. The SDK needs a Node runtime. On an edge runtime (Vercel Edge Functions, Next.js middleware, Cloudflare
        Workers), call the API with <C>fetch</C> — it&apos;s plain HTTPS with Basic auth.
      </P>

      <H2 id="agents">For coding agents</H2>
      <P>
        Handing the integration to Claude Code, Cursor or another coding agent? Everything here is also plain Markdown, and
        the API is machine-readable:
      </P>
      <UL>
        <li>
          <a className="underline" href="/llms.txt">llms.txt</a> is the index, and{" "}
          <a className="underline" href="/developers/llms-full.txt">llms-full.txt</a> has every page in one file. Each page
          also has a <C>.md</C> twin, e.g. <a className="underline" href="/developers/users.md">/developers/users.md</a>.
        </li>
        <li>
          The OpenAPI 3.1 spec,{" "}
          <a className="underline" href="/developers/openapi.json">
            /developers/openapi.json
          </a>
          : every endpoint, field, response and error, plus what we send you. People can browse it in the{" "}
          <Link className="underline" href="/developers/api">
            API reference
          </Link>
          .
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
          <a className="underline" href="/developers/test-vectors.json">Test vectors</a> for verifying our tokens in any
          language, and our public keys at <C>{`${origin}/.well-known/jwks.json`}</C>.
        </li>
      </UL>
      <Note>
        The contract is these docs, the OpenAPI spec, the schemas and the published <C>@yougrowai/node</C> package (0.3.0 and
        later). YouGrow&apos;s own source code isn&apos;t: its main branch can be ahead of what&apos;s deployed.
      </Note>
    </article>
  );
}
