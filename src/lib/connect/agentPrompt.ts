import { PHASE_1, SEVERITY_LABEL, type IntegrationTask } from "./integrationTasks";
import type { GuideField, GuideSend } from "./integrationGuide";
import { LIMITS } from "./protocol";
import { V2_LIMITS, V2_PATHS } from "./v2/contract";

/**
 * The prompt a customer pastes into their coding agent (Claude Code, Cursor, …)
 * in their own repo: what to build, where, in priority order. Server-side only
 * (it quotes the API's limits); contains no secrets — only env var names and the
 * public key id.
 *
 * It has to stand on its own: an agent that can't reach the docs still has the
 * protocol essentials, and it's told where the contract is — the docs, the OpenAPI
 * spec and the published SDK, never YouGrow's source.
 */

export interface AgentPromptInput {
  productName: string;
  keyId: string;
  origin: string;
  /** Whether this YouGrow publishes /developers; when it doesn't, the prompt links nothing there. */
  docs: boolean;
  tasks: IntegrationTask[];
  steps: Array<{ id: string; label: string; completion: string; how?: string | null }>;
  facts: Array<{ id: string; label: string; unit: string | null; source: string }>;
  /** True when those steps / facts are Learn from repo's proposals, not the customer's accepted catalog. */
  proposed?: { steps: boolean; facts: boolean };
  /** What to send, field by field (from the integration guide). */
  send: GuideSend;
  warnings: string[];
}

function proposal(kind: "step" | "fact", productName: string): string {
  return `These ${kind} ids are **proposals** from YouGrow's reading of this repository, not our accepted catalog. Before building against them, accept or edit them in YouGrow → Products → ${productName} → Catalog, then copy this prompt again — otherwise the ids won't match.`;
}

const HOW: Record<string, string> = {
  server_event: "set it in the PATCH where the server makes this happen",
  reconcile: "derive it from stored state in a scheduled sync — resending the same state is harmless",
  client_only: "it's only computed in the browser today — derive it from stored state in a scheduled sync",
};

/** A field as the agent should send it: a fixed JSON value where there is one, else its type. */
const fieldLine = (f: GuideField) => (f.example ? `- \`${f.field}\` = \`${f.example}\` — ${f.when}` : `- \`${f.field}\` (${f.type}) — ${f.when}`);

export function buildAgentPrompt(p: AgentPromptInput): string {
  const o = p.origin;
  const user = `${o}${V2_PATHS.user}`;
  const kb = (bytes: number) => `${bytes / 1024} KB`;
  const lines: string[] = [];
  const push = (...l: string[]) => lines.push(...l);
  push(
    `# Connect ${p.productName} to YouGrow lifecycle email`,
    "",
    `You're working in the ${p.productName} codebase. Connect it to YouGrow (API v2: our server sends each user's current state) in two phases:`,
    "- **Phase 1 — sign-ups and compliance:** send each user's state when they sign up (with their timezone and consent), their email opt-outs, who must never be emailed, and account deletion. Before writing any code, reply with a short plan for Phase 1 — at most 2 PRs — and wait for my OK. Then build it, and stop.",
    "- **Phase 2 — personalisation:** onboarding steps and facts in the same call, and a context endpoint only if we need values fresher than our last write. Optional, and only once Phase 1 is live.",
    "",
    "Build the simplest thing that works: an awaited call where something changes, or a small scheduled job that reads stored state and sends it. Don't build a sync engine, queues or state machines around YouGrow — every write is idempotent, so sending the same state again is harmless. If something below doesn't match the code, ask me rather than design around it.",
    "",
    "## Where the contract is",
    ...(p.docs
      ? [
          `- Read ${o}/developers/llms-full.txt first: every YouGrow docs page in one Markdown file. Single pages: ${o}/developers/users.md, ${o}/developers/context-endpoint.md, ${o}/developers/webhooks.md, ${o}/developers/security.md.`,
          `- The OpenAPI 3.1 spec, generated from YouGrow's own validators: ${o}/developers/openapi.json — every endpoint, field, response and error. JSON Schemas for each body: ${o}/developers/schema/user-patch.json, ${o}/developers/schema/batch-request.json, ${o}/developers/schema/event.json, ${o}/developers/schema/context-response.json, ${o}/developers/schema/webhook.json. Test vectors for verifying our tokens: ${o}/developers/test-vectors.json.`,
        ]
      : ["- This YouGrow doesn't publish developer docs. Work from the protocol essentials below and the `@yougrowai/node` README."]),
    "- The contract is the docs, the OpenAPI spec and the published `@yougrowai/node` package, version 0.4.0 or later (its README and type definitions in node_modules). Don't clone or read YouGrow's own source code: it's the platform, not the contract, and its main branch can be ahead of what's deployed.",
    "",
    "## Ground rules",
    `- Server-side only. Read settings from environment variables: \`YOUGROW_ORIGIN\` (value \`${o}\`), \`YOUGROW_KEY_ID\` (public, value \`${p.keyId}\`) and \`YOUGROW_SECRET\` (secret — it's in our secret manager; never commit, log or send it to a browser).`,
    "- Every request uses HTTP Basic auth over HTTPS: `YOUGROW_KEY_ID` is the username, `YOUGROW_SECRET` the password. There's nothing to sign.",
    "- On a Node server, use our SDK: `npm install @yougrowai/node` (0.4.0 or later; 0.1.x speaks the removed API v1). `const yg = new YouGrow({ keyId: process.env.YOUGROW_KEY_ID, secret: process.env.YOUGROW_SECRET, origin: process.env.YOUGROW_ORIGIN })`, then `await yg.users.update(userId, patch)`, `await yg.users.batch(items)`, `await yg.users.delete(userId)` and `await yg.users.get(userId)`; `await yg.me()` shows which connection the key belongs to. It works from ES modules and from CommonJS: `const { YouGrow } = require(\"@yougrowai/node\")`. For our requests to you, `createVerifier({ keyId: process.env.YOUGROW_KEY_ID, origin: process.env.YOUGROW_ORIGIN })` from `@yougrowai/node/server`. Without the SDK, any HTTP client works — see the protocol essentials below.",
    "- Await every call. The SDK sends each one straight away, with no queue to flush, so nothing is lost when a serverless function (Cloud Functions, Lambda, Vercel) returns. It retries network errors, 429 and 5xx itself. Use a Node runtime for the SDK — not an edge runtime.",
    "- Never let a YouGrow call break our own flows: catch and log failures. Where the work can be retried (a queue worker, or a trigger with retries on), rethrow an error whose `retryable` is true so it's redelivered, and log the rest: a 400 won't succeed as it is. Set `updatedAt` to when the change happened, so a redelivered or out-of-order write is harmless.",
    "- Send a user's state whenever it changes, plus a small daily job that re-sends everyone who signed up or changed in the last two days: it catches anything a failure dropped.",
    "- Existing users: sending them with their real `signedUpAt` is safe (sign-up journeys only enrol people inside their window), so a backfill is optional; it lets later sequences reach them.",
    "- Add tests for each part, and keep changes small and reviewable.",
    "",
    "## Protocol essentials",
    `- \`PATCH ${user}\` (the userId URL-encoded) with a JSON body of the user's current state. It's a JSON Merge Patch: fields you send replace YouGrow's, fields you leave out stay, \`null\` clears one, and \`steps\`, \`facts\` and \`traits\` merge key by key. The first write creates the user. At most ${kb(V2_LIMITS.maxBodyBytes)}.`,
    `- Fields: \`signedUpAt\` (when the account was created, ISO 8601 with a timezone — it starts sign-up journeys), \`email\`, \`firstName\`, \`lastName\`, \`timezone\` (IANA, e.g. \`Europe/London\`), \`locale\` (BCP 47, e.g. \`en-GB\`), \`consent\` (\`consent\`, \`soft_opt_in\`, \`corporate_subscriber\` or \`none\`), \`subscribed\` (\`false\` = opted out in our product), \`excluded\` (\`{"reason":"staff"}\` = never email them; \`null\` lifts it), \`steps\` (step id → the ISO 8601 time it was done, or \`null\`), \`facts\` (fact id → latest value: number, string or boolean; \`null\` removes it), \`traits\` (anything else journeys branch on — not email, names, timezone or locale), \`updatedAt\` (when you read this state; a write older than the newest applied is ignored). At most ${V2_LIMITS.maxSteps} steps, ${V2_LIMITS.maxFacts} facts and ${V2_LIMITS.maxTraits} traits per user. Unknown fields are refused. An invalid \`email\`, \`firstName\`, \`lastName\`, \`timezone\` or \`locale\` doesn't sink the write: it's left as it was and listed in \`ignoredFields\`.`,
    "- `consent` only matters for marketing emails: one that's due without a basis the connection accepts is skipped, never sent late. Service emails, like a welcome, need none.",
    '- Responses: `200 {"applied":true,"user":{…}}` (plus `ignoredFields` when a profile field was left as it was); `200 {"applied":false,"reason":"stale_write"}` or `"deleted_later"` — a skipped write, not an error, so don\'t retry it; `400 {"error":"invalid","fields":[{"path":"…","message":"…"}]}` (or `invalid_json`) — fix the payload, don\'t retry it; `401 unauthorized` — wrong key id or secret; `413 body_too_large`; `429 rate_limited` — wait `Retry-After` seconds; `5xx` or a network error — retry with backoff (writes are idempotent).',
    `- Many users: \`POST ${o}${V2_PATHS.batch}\` with \`{"users":[{"userId":"…", …the same fields}]}\` — 1–${V2_LIMITS.maxBatch} per request, each applied on its own. The response counts \`applied\`, \`ignored\` and \`failed\`; \`results\` lists the items that weren't applied, and applied ones with \`fields_ignored\`. \`yg.users.batch(items)\` takes any number.`,
    `- Read back: \`GET ${user}\` → the state plus \`enrolments\` and \`optOuts\`; \`404\` when YouGrow doesn't hold them. Erase: \`DELETE\` the same URL → \`204\`, safe to repeat. Check the key: \`GET ${o}${V2_PATHS.me}\` → the connection it belongs to (name, environment, status).`,
    `- Milestones (optional): \`POST ${o}${V2_PATHS.events}\` with \`{"event":"report.exported","occurredAt":"…"}\` — for a user already sent. \`user.signed_up\`, \`onboarding.step_completed\`, \`user.marketing_consent_granted\`, \`user.deleted\` and \`email_preferences.updated\` are refused: they're state (\`signedUpAt\`, \`steps\`, \`consent\`, \`subscribed\`, DELETE).`,
    "- Rate limits per key: 600 requests a minute and 20,000 an hour; a batch counts as one request.",
    `- Our requests to you (the context endpoint, webhooks) carry \`Authorization: Bearer <JWT>\`, ES256, with keys at \`${o}/.well-known/jwks.json\`. Check \`iss\` = \`${o}\`, \`aud\` = your key id, \`dir\` (\`context\` or \`webhook\`), \`exp\`, and \`body_sha256\` = base64url SHA-256 of the raw request body. Verify before parsing.`,
    "- Webhook types: `email_preferences.updated` (an unsubscribe from one of our emails: record it as an opt-out), `email.suppressed` (`reason` `hard_bounce` or `complaint`: record a complaint as an objection to marketing) and `connection.test`. Reply 2xx to anything else. API writes never trigger a webhook, and an opt-out made in our emails holds whatever you send, so echoing the change back in your next PATCH is harmless.",
    `- Context response (only if you build the optional context endpoint): \`{ asOf, steps, nextStep, facts, insights, consent?, hold?, exit? }\` — at most 20 steps, 50 facts and 20 insights, ${kb(LIMITS.maxContextBytes)}, within the connection's timeout (2 seconds by default).`,
    "",
    "## Tasks",
    "Under each task, **Found in our code** and **Look at** come from YouGrow's automated reading of this repository. Treat them as leads, not facts: check where each value is actually written, and whether the data exists at that moment, before relying on them.",
  );
  let n = 0;
  const task = (t: IntegrationTask) => {
    n += 1;
    push("", `#### ${n}. [${SEVERITY_LABEL[t.severity]}] ${t.title}${t.status === "done" ? " — already working, just check it" : ""}`, `Do: ${t.action}`, `If skipped: ${t.ifSkipped}`);
    if (t.fromCode.length) push("Found in our code:", ...t.fromCode.map((c) => `- ${c}`));
    if (t.files.length) push("Look at:", ...t.files.map((f) => `- \`${f.path}${f.line ? `:${f.line}` : ""}\``));
    if (t.id === "steps") {
      if (p.steps.length) {
        if (p.proposed?.steps) push(proposal("step", p.productName));
        push(
          "Steps (use these exact ids; each value is the ISO 8601 time it was done):",
          ...p.steps.map((s) => `- \`${s.id}\` — ${s.label}${s.completion ? `; done when ${s.completion}` : ""}${s.how && HOW[s.how] ? ` (${HOW[s.how]})` : ""}`),
        );
      }
      if (p.facts.length) {
        if (p.proposed?.facts) push(proposal("fact", p.productName));
        push("Facts (ids must match exactly; send the latest value):", ...p.facts.map((f) => `- \`${f.id}\` — ${f.label}${f.unit ? ` (${f.unit})` : ""}${f.source ? `; from ${f.source}` : ""}`));
      }
    }
    if (t.id === "context") {
      push(
        "Skip it unless a value changes too fast to send, or you want insight sentences in emails. If you build it: return `steps` and `facts` with the same ids as above, and `nextStep` = the first step not done. Verify our request first (see Protocol essentials) — in Node, `createVerifier` from `@yougrowai/node/server` does all of it.",
      );
    }
  };
  const later = p.tasks.filter((t) => !PHASE_1.has(t.id));
  push("", "### Phase 1 — sign-ups and compliance (plan, build, then stop)");
  p.tasks.filter((t) => PHASE_1.has(t.id)).forEach(task);
  if (later.length) {
    push("", "### Phase 2 — personalisation (later, once Phase 1 is live)");
    later.forEach(task);
  }

  const s = p.send;
  push("", "## What to send (exact fields)", `At sign-up — one \`PATCH ${user}\` with:`, ...s.signup.map(fieldLine));
  push("", "Opt-outs and exclusions — the same PATCH, whenever they change:", ...s.compliance.map(fieldLine));
  push("", `On erasure: \`DELETE ${user}\` — ${s.deletion}`);
  if (s.progress.length) {
    push("", "Phase 2 — in the same PATCH, whenever they change:", ...s.progress.map(fieldLine));
  }
  if (s.milestones.length) {
    push("", `Optional milestones — \`POST ${o}${V2_PATHS.events}\`:`, ...s.milestones.map((m) => `- \`${m.event}\` — ${m.when}`));
  }
  if (p.warnings.length) push("", "## Gaps YouGrow noticed in our code", ...p.warnings.map((w) => `- ${w}`));
  push(
    "",
    "## Done when",
    "Phase 1:",
    `- \`yg.me()\` (or \`GET ${o}${V2_PATHS.me}\`) returns ${p.productName}'s connection, in the environment you meant.`,
    `- \`GET ${user}\` for a test account (or \`yg.users.get\`) shows what you sent, with \`signedUpAt\` set. Each write also appears in YouGrow → Products → ${p.productName} → **Events** within seconds.`,
    "- Opting a test account out sets `\"subscribed\": false` (a JSON boolean), and an excluded account (e.g. staff) shows `excluded` — GET shows both.",
    "- Erasing a test account sends `DELETE`, and GET then answers 404. If your product has a deletion grace period, run your erasure code directly for the test account rather than waiting.",
    "- **Test webhook** (YouGrow → the connection's Settings) reaches your handler and gets a 2xx, and an unsubscribe from a test email updates your records.",
    "- A failed call is retried when its error is `retryable` and logged otherwise, and the daily re-sync runs.",
    "- Journeys start in **test** mode, where only people on a journey's test list get email — add your test accounts there. When a journey goes live, YouGrow enrols everyone who signed up inside its window: there's nothing to resend.",
    "",
    "Phase 2:",
    "- GET shows `steps` and `facts` changing as test accounts complete steps.",
    "- If you built the context endpoint: **Test connection**, run with a real test account's id, returns the steps and facts you expect. It passes any valid response, so check the content, not just the tick.",
  );
  return lines.join("\n");
}
