import { SEVERITY_LABEL, type IntegrationTask } from "./integrationTasks";
import { HEADER_KEY_ID, HEADER_SIGNATURE, HEADER_TIMESTAMP, LIMITS, SIGNATURE_TOLERANCE_SEC } from "./protocol";

/**
 * The prompt a customer pastes into their coding agent (Claude Code, Cursor, …)
 * in their own repo: what to build, where, in priority order. Server-side only
 * (it quotes the protocol's limits); contains no secrets — only env var names
 * and the public key id.
 *
 * It has to stand on its own: an agent that can't reach the docs still has the
 * protocol essentials, and it's told where the contract is — the docs and the
 * published SDK, never YouGrow's source.
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
  events: Array<{ name: string; when: string }>;
  warnings: string[];
}

const HOW: Record<string, string> = {
  server_event: "send it where the server makes this happen",
  reconcile: "derive it from stored state in a scheduled job, with a stable messageId like `{userId}:step:{stepId}`",
  client_only: "it's only computed in the browser today — derive it from stored state in a scheduled job",
};

export function buildAgentPrompt(p: AgentPromptInput): string {
  const o = p.origin;
  const lines: string[] = [];
  const push = (...l: string[]) => lines.push(...l);
  push(
    `# Connect ${p.productName} to YouGrow lifecycle email`,
    "",
    `You're working in the ${p.productName} codebase. Implement our side of the YouGrow integration below, in priority order. YouGrow analysed this repository (read-only) to find where each piece belongs — verify each location before changing it, and ask me if something doesn't match.`,
    "",
    "## Where the contract is",
    ...(p.docs
      ? [
          `- Read ${o}/developers/llms-full.txt first: every YouGrow docs page in one Markdown file. Single pages: ${o}/developers/events.md, ${o}/developers/context-endpoint.md, ${o}/developers/webhooks.md, ${o}/developers/security.md.`,
          `- JSON Schemas for every message, generated from YouGrow's own validators: ${o}/developers/schema/events.json, ${o}/developers/schema/context-request.json, ${o}/developers/schema/context-response.json, ${o}/developers/schema/webhook.json. Signing test vectors: ${o}/developers/test-vectors.json.`,
        ]
      : ["- This YouGrow doesn't publish developer docs. Work from the protocol essentials below and the `@yougrowai/node` README."]),
    "- The contract is the docs and the published `@yougrowai/node` package (its README and type definitions in node_modules). Don't clone or read YouGrow's own source code: it's the platform, not the contract, and its main branch can be ahead of what's deployed.",
    "",
    "## Ground rules",
    `- Server-side only. Read settings from environment variables: \`YOUGROW_ORIGIN\` (value \`${o}\`), \`YOUGROW_KEY_ID\` (public, value \`${p.keyId}\`) and \`YOUGROW_SECRET\` (secret — it's in our secret manager; never commit, log or send it to a browser).`,
    "- On a Node server, use our SDK (`npm install @yougrowai/node`) — it signs, batches and retries events and verifies our requests. It works from ES modules, and from CommonJS (`require`) in 0.2.0 and later. Point it at YOUGROW_ORIGIN: pass `endpoint` = YOUGROW_ORIGIN + `/api/v1/events` to `new YouGrow(…)`, and `issuer` = YOUGROW_ORIGIN to `createVerifier(…)`. Without the SDK, sign requests as below.",
    "- In a serverless function (Cloud Functions, Lambda, Vercel), `await yg.flush()` before it returns — work left running afterwards may never finish. Use a Node runtime: the SDK needs `node:crypto`, so edge runtimes won't work.",
    "- Give every event a unique `messageId` — deterministic where you can, so retries and repeats are harmless.",
    "- Never let a YouGrow call break our own flows: send events asynchronously, and catch and log failures.",
    "- Add tests for each part, and keep changes small and reviewable.",
    "",
    "## Protocol essentials",
    `- Events: \`POST ${o}/api/v1/events\` with body \`{"batch":[…]}\` — 1–${LIMITS.maxBatch} messages, at most ${LIMITS.maxBodyBytes / 1024} KB. Headers: \`${HEADER_KEY_ID}\`, \`${HEADER_TIMESTAMP}\` (unix seconds, within ${SIGNATURE_TOLERANCE_SEC / 60} minutes of our clock) and \`${HEADER_SIGNATURE}\` = \`v1=\` + hex HMAC-SHA256(secret, \`"events:" + timestamp + "." + rawBody\`). Sign the exact bytes you send.`,
    "- Messages: `identify` — `{ type, messageId, userId, timestamp, traits, consent: { basis } }`; `track` — `{ type, messageId, userId, timestamp, event, properties }`. Timestamps are ISO 8601 with a timezone.",
    `- Our requests to you (context endpoint, webhooks) carry \`Authorization: Bearer <JWT>\`, ES256, with keys at \`${o}/.well-known/jwks.json\`. Check \`iss\` = \`${o}\`, \`aud\` = your key id, \`dir\` (\`context\` or \`webhook\`), \`exp\`, and \`body_sha256\` = base64url SHA-256 of the raw request body. Verify before parsing.`,
    `- Context response: \`{ asOf, steps, nextStep, facts, insights, consent?, hold?, exit? }\` — at most 20 steps, 50 facts and 20 insights, ${LIMITS.maxContextBytes / 1024} KB, within 5 seconds.`,
    "",
    "## Tasks",
  );
  p.tasks.forEach((t, i) => {
    push("", `### ${i + 1}. [${SEVERITY_LABEL[t.severity]}] ${t.title}${t.status === "done" ? " — already working, just check it" : ""}`, `Do: ${t.action}`, `If skipped: ${t.ifSkipped}`);
    if (t.fromCode.length) push("Found in our code:", ...t.fromCode.map((c) => `- ${c}`));
    if (t.files.length) push("Look at:", ...t.files.map((f) => `- \`${f.path}${f.line ? `:${f.line}` : ""}\``));
    if (t.id === "steps" && p.steps.length) {
      push("Steps (use these exact ids):", ...p.steps.map((s) => `- \`${s.id}\` — ${s.label}${s.completion ? `; done when ${s.completion}` : ""}${s.how && HOW[s.how] ? ` (${HOW[s.how]})` : ""}`));
    }
    if (t.id === "context") {
      if (p.steps.length) push(`Return \`steps\` with these ids: ${p.steps.map((s) => `\`${s.id}\``).join(", ")}, and \`nextStep\` = the first not done.`);
      if (p.facts.length) push("Return these `facts` (ids must match exactly):", ...p.facts.map((f) => `- \`${f.id}\` — ${f.label}${f.unit ? ` (${f.unit})` : ""}${f.source ? `; from ${f.source}` : ""}`));
      push("Verify our request first (see Protocol essentials) — in Node, `createVerifier` from `@yougrowai/node/server` does all of it.");
    }
  });
  if (p.events.length) {
    push("", "## Events to send (exact names)", ...p.events.map((e) => `- \`${e.name}\` — ${e.when}`));
  }
  if (p.warnings.length) push("", "## Gaps YouGrow noticed in our code", ...p.warnings.map((w) => `- ${w}`));
  push(
    "",
    "## Done when",
    `- YouGrow → Products → ${p.productName} → **Events** shows \`identify\` and \`user.signed_up\` arriving (and step events as steps are completed).`,
    "- **Test connection** on the same page passes, showing the steps and facts above.",
    "- Deleting a test account sends `user.deleted`; changing its email preferences sends `email_preferences.updated`.",
  );
  return lines.join("\n");
}
