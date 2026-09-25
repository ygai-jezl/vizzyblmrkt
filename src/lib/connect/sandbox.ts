import { forTenant, getConnectionKey, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type {
  ConnectionCatalog,
  ProductConnection,
  SandboxUser,
} from "@/lib/types/productConnection";
import { readRequestTextCapped } from "@/lib/http/readBody";
import { outboundIssuer, publishedJwks } from "./outboundSigner";
import { bearerToken, verifyOutboundToken, type OutboundDirection } from "./outboundToken";
import {
  ContextRequestSchema,
  HEADER_KEY_ID,
  WebhookPayloadSchema,
  zodReason,
  type ProductContext,
} from "./protocol";
import type { UserPatch } from "./v2/contract";
import { deleteUser, patchUser } from "./v2/users";

/**
 * The Sandbox: a platform-hosted stand-in for a connected product, so the whole
 * flow (events in → context pull → personalised email → unsubscribe sync) can be
 * proven before any real product writes integration code.
 *
 * It behaves like a real integration: its context and webhook endpoints verify
 * the platform's signed JWT against the published keys exactly as a product
 * would (the same handlers back
 * the public /api/sandbox/* reference routes), and "fire event" sends a test
 * user's state through the real API v2 write path. The platform calls these
 * IN-PROCESS — the same code with no network hop, so no origin is trusted and
 * there is no SSRF surface.
 */

/** A GEO-analytics-style SaaS: mirrors vizzybl.ai's brand → audit → prompts. */
export const SANDBOX_CATALOG: ConnectionCatalog = {
  events: [
    { name: "user.signed_up", label: "Signed up", description: "A new user created an account." },
    {
      name: "onboarding.step_completed",
      label: "Onboarding step completed",
      description: "properties.step is the onboarding step id.",
    },
    { name: "onboarding.completed", label: "Onboarding completed", description: "Every onboarding step is done." },
    { name: "user.deleted", label: "User deleted", description: "Erase this user and their history." },
    {
      name: "email_preferences.updated",
      label: "Email preferences updated",
      description: "properties.category + properties.subscribed.",
    },
  ],
  traits: [
    { key: "plan", type: "string", label: "Plan", description: "free, pro or ultra." },
    { key: "company", type: "string", label: "Company", description: "" },
    { key: "jobRole", type: "string", label: "Job role", description: "" },
  ],
  onboardingSteps: [
    { id: "create_brand", label: "Add your brand", url: "https://app.example.com/brand/new", order: 0, completion: "The brand has a name and a domain." },
    { id: "run_audit", label: "Run your first audit", url: "https://app.example.com/audits/new", order: 1, completion: "An audit has finished." },
    { id: "monitor_prompts", label: "Monitor your first prompts", url: "https://app.example.com/prompts", order: 2, completion: "At least one prompt is being monitored." },
  ],
  facts: [
    { id: "share_of_voice", label: "Share of voice", type: "number", unit: "%", description: "How often AI answers mention the brand.", source: "Daily visibility snapshot" },
    { id: "competitors_named", label: "Competitors named instead of you", type: "number", unit: null, description: "", source: "Latest prompt results" },
    { id: "engines_checked", label: "AI engines checked", type: "number", unit: null, description: "", source: "Latest prompt results" },
  ],
  glossary: [
    { term: "Share of voice", definition: "How often AI answers mention your brand, compared with competitors." },
    { term: "Citation", definition: "A source an AI answer links to or quotes." },
  ],
};

/** Step links in the template point here. */
export const SANDBOX_LINK_DOMAINS = ["example.com"];

/** The default test user: no steps done, three facts, two insights. */
export function defaultSandboxUser(email: string, firstName = "Alex"): SandboxUser {
  return {
    userId: "sandbox_alex",
    email,
    firstName,
    timezone: "Europe/London",
    steps: {},
    facts: [
      { id: "share_of_voice", label: "Share of voice", value: 12, unit: "%" },
      { id: "competitors_named", label: "Competitors named instead of you", value: 3, unit: null },
      { id: "engines_checked", label: "AI engines checked", value: 4, unit: null },
    ],
    insights: [
      {
        id: "competitors_named",
        sentence: "ChatGPT named 3 competitors in answers about your category, but not you.",
        factIds: ["competitors_named"],
        weight: 0.8,
        supportsStep: "monitor_prompts",
      },
      {
        id: "share_of_voice",
        sentence: "Across 4 AI engines, your brand appears in 12% of answers about your category.",
        factIds: ["share_of_voice", "engines_checked"],
        weight: 0.6,
        supportsStep: "run_audit",
      },
    ],
  };
}

/** What the sandbox's context endpoint returns for one test user. */
export function buildSandboxContext(
  conn: ProductConnection,
  user: SandboxUser,
  nowMs = Date.now(),
): ProductContext {
  const asOf = new Date(nowMs).toISOString();
  const steps = [...conn.catalog.onboardingSteps]
    .sort((a, b) => a.order - b.order)
    .map((s) => ({
      id: s.id,
      label: s.label,
      done: user.steps[s.id] === true,
      doneAt: user.steps[s.id] === true ? asOf : null,
      url: s.url ?? null,
    }));
  const next = steps.find((s) => !s.done);
  return {
    asOf,
    steps,
    nextStep: next ? { id: next.id, label: next.label, url: next.url } : null,
    facts: user.facts.map((f) => ({ ...f, source: "sandbox", observedAt: asOf })),
    insights: user.insights,
    consent: { basis: "consent" },
  };
}

// ---- Reference endpoints (signed, like a real product's) ------------------------

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Verify a platform→product request the way a real product must. */
async function verifyInbound(
  req: Request,
  connectionId: string,
  direction: OutboundDirection,
  deps: { db?: FirestoreLike; nowMs?: number },
): Promise<{ ok: true; raw: string; ctx: TenantContext; conn: ProductConnection } | { ok: false; res: Response }> {
  const nowMs = deps.nowMs ?? Date.now();
  const raw = await readRequestTextCapped(req, 16 * 1024);
  if (raw === null) return { ok: false, res: json(413, { error: "body_too_large" }) };
  const rec = await getConnectionKey(req.headers.get(HEADER_KEY_ID)?.trim() ?? "", deps.db);
  if (!rec || rec.connectionId !== connectionId) return { ok: false, res: json(401, { error: "unknown_key" }) };
  const ctx: TenantContext = { tenantId: rec.tenantId, region: rec.region, source: "api_key" };
  const conn = await forTenant(ctx, deps.db).productConnections.getById(connectionId);
  if (!conn || conn.kind !== "sandbox" || conn.status === "revoked") {
    return { ok: false, res: json(404, { error: "not_found" }) };
  }
  let jwks;
  let issuer: string;
  try {
    jwks = await publishedJwks();
    issuer = outboundIssuer();
  } catch {
    return { ok: false, res: json(503, { error: "keys_unavailable" }) };
  }
  const verified = verifyOutboundToken({
    token: bearerToken(req.headers.get("authorization")),
    jwks,
    issuer,
    audience: conn.keyId,
    direction,
    rawBody: raw,
    nowMs,
  });
  if (!verified.ok) return { ok: false, res: json(401, { error: verified.reason }) };
  return { ok: true, raw, ctx, conn };
}

/** POST /api/sandbox/context/[connectionId] — the reference context endpoint. */
export async function handleSandboxContextRequest(
  req: Request,
  connectionId: string,
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<Response> {
  const v = await verifyInbound(req, connectionId, "context", deps);
  if (!v.ok) return v.res;
  let body: unknown;
  try {
    body = JSON.parse(v.raw);
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const parsed = ContextRequestSchema.safeParse(body);
  if (!parsed.success) return json(400, { error: "invalid_request", detail: zodReason(parsed.error) });
  const user = v.conn.sandbox?.users.find((u) => u.userId === parsed.data.userId);
  if (!user) return json(404, { error: "unknown_user" });
  return json(200, buildSandboxContext(v.conn, user, deps.nowMs));
}

const INBOX_SIZE = 20;

/** POST /api/sandbox/webhook/[connectionId] — the reference webhook receiver. */
export async function handleSandboxWebhookRequest(
  req: Request,
  connectionId: string,
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<Response> {
  const v = await verifyInbound(req, connectionId, "webhook", deps);
  if (!v.ok) return v.res;
  let body: unknown;
  try {
    body = JSON.parse(v.raw);
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const parsed = WebhookPayloadSchema.safeParse(body);
  if (!parsed.success) return json(400, { error: "invalid_payload", detail: zodReason(parsed.error) });
  const receivedAt = new Date(deps.nowMs ?? Date.now()).toISOString();
  await forTenant(v.ctx, deps.db).productConnections.claim(connectionId, (cur) => {
    if (!cur.sandbox) return null;
    const entry = { receivedAt, type: parsed.data.type, body: v.raw.slice(0, 4000) };
    return {
      sandbox: { ...cur.sandbox, webhookInbox: [entry, ...cur.sandbox.webhookInbox].slice(0, INBOX_SIZE) },
    };
  });
  return json(200, { ok: true });
}

// ---- Fire events (the sandbox acting as the product) ------------------------------

export type SandboxAction =
  | { kind: "identify" }
  | { kind: "signed_up" }
  | { kind: "step"; step: string }
  | { kind: "completed" }
  | { kind: "preferences"; category: string; subscribed: boolean }
  | { kind: "deleted" };

/** The API v2 write a sandbox action stands for (null: an erasure). */
function patchFor(user: SandboxUser, action: SandboxAction, conn: ProductConnection, now: string): UserPatch | null {
  const profile: UserPatch = {
    email: user.email,
    firstName: user.firstName ?? null,
    timezone: user.timezone,
    traits: { plan: "pro" },
    consent: "consent",
  };
  switch (action.kind) {
    case "identify":
      return profile;
    case "signed_up":
      return { ...profile, signedUpAt: now };
    case "step":
      return { steps: { [action.step]: now } };
    case "completed":
      return { steps: Object.fromEntries(conn.catalog.onboardingSteps.map((s) => [s.id, now])) };
    case "preferences":
      // API v2 has one product-side switch for lifecycle email; the category is the sandbox UI's label.
      return { subscribed: action.subscribed };
    case "deleted":
      return null;
  }
}

/**
 * Act as the product: send one test user's state (or erase them) through the
 * REAL API v2 write path, in-process — the same operations the public routes
 * run once a key is authenticated. A step also ticks the step on the test user,
 * so the sandbox's context endpoint agrees with the state it sent.
 */
export async function fireSandboxEvent(
  ctx: TenantContext,
  conn: ProductConnection,
  userId: string,
  action: SandboxAction,
  deps: { db?: FirestoreLike; nowMs?: number },
): Promise<{ status: number; body: unknown }> {
  const user = conn.sandbox?.users.find((u) => u.userId === userId);
  if (!user) return { status: 404, body: { error: "unknown_user" } };
  if (conn.status === "revoked") return { status: 409, body: { error: "connection_revoked" } };

  const nowMs = deps.nowMs ?? Date.now();
  const patch = patchFor(user, action, conn, new Date(nowMs).toISOString());
  const opts = { db: deps.db, nowMs };
  if (!patch) {
    await deleteUser(ctx, conn, user.userId, opts);
    return { status: 200, body: { deleted: true } };
  }
  const result = await patchUser(ctx, conn, user.userId, patch, opts);
  if ("invalid" in result) return { status: 400, body: { error: "invalid", fields: result.invalid } };

  if (action.kind === "step") {
    await forTenant(ctx, deps.db).productConnections.claim(conn.id, (cur) => {
      if (!cur.sandbox) return null;
      const users = cur.sandbox.users.map((u) =>
        u.userId === userId ? { ...u, steps: { ...u.steps, [action.step]: true } } : u,
      );
      return { sandbox: { ...cur.sandbox, users } };
    });
  }
  return { status: 200, body: result };
}
