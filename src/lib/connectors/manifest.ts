import { z } from "zod";
import { MEANINGS } from "@/lib/metrics/meanings";

/**
 * The connector manifest: what a connector is, how it signs in, which hosts it may call, what it
 * reads and what it produces, as pure data. The same file works whether YouGrow writes it, a
 * contributor sends it or (later) a vendor publishes it, so it holds no functions: code a
 * connector needs is named by a hook id (`<connector>.<name>`) and lives in
 * src/lib/connectors/handlers. src/lib/connectors/manifest.test.ts checks every manifest parses,
 * survives a JSON round trip and writes in house style.
 *
 * Fields, in the order of the plan's design:
 * - connect: the sign-in methods. Only token_fields is built (connectors 1a); the registry refuses
 *   the others until their piece builds them.
 * - api: every outbound call. Only these hosts are reachable, under these limits
 *   (src/lib/connectors/safeFetch.ts enforces them).
 * - verify: the one request that proves a connection works, run before anything is saved.
 * - shares: what we read or write, in plain words. Every permission or scope a sign-in asks for
 *   has a line that names it.
 * - produces: each stream for people and agents: its shape, keys, the meaning of every number
 *   (a MEANINGS key) and the shared keys it joins on.
 * - uses: what it plugs into in YouGrow.
 * - hooks: named handler ids, never functions.
 */

/** Ids the routes and pages use beside /connectors/[connectorId], so no connector may take them. */
export const RESERVED_CONNECTOR_IDS = ["browse", "callback", "connections"] as const;

export const CONNECT_METHODS = ["token_fields", "oauth_pkce", "share_access"] as const;
export type ConnectMethodName = (typeof CONNECT_METHODS)[number];

export const CONNECTOR_CATEGORIES = ["analytics", "search", "social", "email", "code", "crm", "shop"] as const;
export const STREAM_SHAPES = ["numbers", "events", "records", "text"] as const;
/** The shared keys a stream may join on (ontology rule: one way of writing each). */
export const JOIN_KEYS = ["day", "page", "topic", "person", "company", "idea"] as const;
export type JoinKey = (typeof JOIN_KEYS)[number];
/** The fixed list of dimensions a live read may group by. */
export const LIVE_BY = ["day", "page", "topic"] as const;
export type LiveBy = (typeof LIVE_BY)[number];
export const USES = ["vizzy.read", "signals.search", "signals.traffic", "signals.bots"] as const;

/** Hard caps on every live read, whatever a manifest says. */
export const LIVE_LIMITS = { maxDays: 93, maxRows: 100, maxBytes: 512 * 1024 } as const;

/** Plain words a person reads: one line, no markup. The house style test checks the words. */
const Copy = (max = 300) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !/[\n<>]/.test(s), "one plain line");

/** A bare host: lower case, dotted, no scheme, port, path or wildcard. */
const Host = z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "a bare host such as api.example.com");

const HttpsUrl = z
  .string()
  .max(2000)
  .refine((u) => {
    try {
      const url = new URL(u);
      return url.protocol === "https:" && !url.username && !url.password && !url.port;
    } catch {
      return false;
    }
  }, "an https URL with no port or credentials");

/** `<connector>.<name>`: a handler in src/lib/connectors/handlers. */
const HookId = z.string().regex(/^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/, "a hook id such as cloudflare.zoneDaily");

const MeaningKeySchema = z.string().refine((k) => Object.prototype.hasOwnProperty.call(MEANINGS, k), "a key in src/lib/metrics/meanings.ts");

const FieldKey = z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/);

/** A regular expression source that compiles and is anchored at both ends. */
const AnchoredPattern = z.string().refine((p) => {
  if (!p.startsWith("^") || !p.endsWith("$")) return false;
  try {
    new RegExp(p);
    return true;
  } catch {
    return false;
  }
}, "an anchored regular expression");

export const TokenFieldSchema = z
  .object({
    key: FieldKey,
    label: Copy(60),
    /** A secret is sealed in the vault and never shown again; anything else is stored as typed. */
    secret: z.boolean(),
    help: Copy().optional(),
    pattern: AnchoredPattern,
    minLength: z.number().int().min(1).max(4096),
    maxLength: z.number().int().min(1).max(4096),
  })
  .strict()
  .refine((f) => f.minLength <= f.maxLength, "minLength is above maxLength");

const TokenFieldsMethodSchema = z
  .object({
    method: z.literal("token_fields"),
    fields: z.array(TokenFieldSchema).min(1).max(6),
    /** The non secret field that names what was connected (a zone id, a site). */
    account: FieldKey,
    /** The secret field sent as `Authorization: Bearer <value>`. */
    auth: z.object({ field: FieldKey, scheme: z.literal("Bearer") }).strict(),
    /** What the token must be allowed to do, in the provider's own words. */
    permissions: z.array(Copy(80)).min(1).max(10),
    /** A link that opens the provider's token form already filled in, where it has one. */
    tokenLink: HttpsUrl.optional(),
    /** How to make the token, step by step. */
    steps: z.array(Copy()).min(1).max(10),
  })
  .strict();

const OAuthMethodSchema = z
  .object({
    method: z.literal("oauth_pkce"),
    client: z.literal("google"),
    /** One scope per connection (decision 3 of the Connectors 1 plan). */
    scopes: z.array(HttpsUrl).length(1),
  })
  .strict();

const ShareAccessMethodSchema = z
  .object({
    method: z.literal("share_access"),
    google: z.enum(["search-console", "ga4"]),
    /** The role to give the connection's own address, in the product's words. */
    role: Copy(60),
  })
  .strict();

export const ConnectMethodSchema = z.discriminatedUnion("method", [TokenFieldsMethodSchema, OAuthMethodSchema, ShareAccessMethodSchema]);

const RateLimitSchema = z
  .object({
    perMinute: z.number().int().min(1).max(600),
    perHour: z.number().int().min(1).max(36_000),
  })
  .strict();

export const ShareSchema = z
  .object({
    /** What is read, from the provider's side. */
    what: Copy(120),
    detail: Copy(160).optional(),
    direction: z.enum(["read", "never"]),
    /** Where it goes in YouGrow and how long it is kept. */
    where: Copy(160),
    /** The permissions or scopes this line relies on: every one a sign-in asks for is named by a line. */
    needs: z.array(z.string().min(1).max(200)).max(10).default([]),
  })
  .strict();

export const ProduceSchema = z
  .object({
    stream: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
    description: Copy(160),
    shape: z.enum(STREAM_SHAPES),
    /** The stream's own key names, e.g. day, page, query. */
    keys: z.array(z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/)).min(1).max(6),
    /** Each number's meaning key. A number with no meaning never reaches an agent. */
    measures: z.array(MeaningKeySchema).max(20),
    /** Which of its keys join on which shared key. */
    joins: z.record(z.string(), z.enum(JOIN_KEYS)),
    /** Days before a day's numbers settle. */
    lagDays: z.number().int().min(0).max(14),
    /** True when a row is about a person. Refused until the data processing agreement covers it. */
    personal: z.boolean(),
    /** The dimensions a live read of this stream may group by. */
    liveBy: z.array(z.enum(LIVE_BY)).min(1).max(LIVE_BY.length),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.shape === "numbers" && p.measures.length === 0) ctx.addIssue({ code: "custom", message: "a numbers stream needs at least one measure" });
    if (p.shape !== "numbers" && p.measures.length > 0) ctx.addIssue({ code: "custom", message: "only a numbers stream has measures" });
    for (const k of Object.keys(p.joins)) {
      if (!p.keys.includes(k)) ctx.addIssue({ code: "custom", message: `joins names ${k}, which is not one of its keys` });
    }
    for (const by of p.liveBy) {
      if (!Object.values(p.joins).includes(by)) ctx.addIssue({ code: "custom", message: `liveBy ${by} has no key that joins on it` });
    }
    if (new Set(p.measures).size !== p.measures.length) ctx.addIssue({ code: "custom", message: "a measure is listed twice" });
  });

export const ConnectorManifestSchema = z
  .object({
    /** The manifest format's version. */
    schema: z.literal(1),
    id: z
      .string()
      .regex(/^[a-z][a-z0-9-]{1,39}$/)
      .refine((id) => !(RESERVED_CONNECTOR_IDS as readonly string[]).includes(id), "a reserved id"),
    name: Copy(60),
    /** One line for Browse. */
    summary: Copy(160),
    category: z.enum(CONNECTOR_CATEGORIES),
    publisher: z.literal("yougrow"),
    /** The switch that lists it (src/lib/connectors/flags.ts reads it). */
    switch: z.string().regex(/^CONNECTOR_[A-Z0-9_]+_ENABLED$/),
    connect: z.array(ConnectMethodSchema).min(1).max(3),
    api: z
      .object({
        hosts: z.array(Host).min(1).max(5),
        limits: z.object({ connection: RateLimitSchema, brand: RateLimitSchema }).strict(),
        timeoutMs: z.number().int().min(1000).max(30_000),
        maxBytes: z.number().int().min(1024).max(LIVE_LIMITS.maxBytes),
      })
      .strict(),
    verify: z.object({ method: z.enum(["GET", "POST"]), url: HttpsUrl, hook: HookId }).strict(),
    shares: z.array(ShareSchema).min(1).max(10),
    produces: z.array(ProduceSchema).min(1).max(10),
    uses: z.array(z.enum(USES)).max(USES.length),
    hooks: z.object({ live: HookId }).strict(),
    /** What Disconnect can and can't do at the provider, for the screen and help. */
    disconnect: Copy(),
  })
  .strict()
  .superRefine((m, ctx) => {
    const hostOf = (u: string) => new URL(u).hostname;
    if (!m.api.hosts.includes(hostOf(m.verify.url))) ctx.addIssue({ code: "custom", message: "verify.url is not on a declared host" });
    for (const hook of [m.verify.hook, m.hooks.live]) {
      if (!hook.startsWith(`${m.id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())}.`)) {
        ctx.addIssue({ code: "custom", message: `hook ${hook} must start with the connector's own name` });
      }
    }
    const methods = m.connect.map((c) => c.method);
    if (new Set(methods).size !== methods.length) ctx.addIssue({ code: "custom", message: "a sign-in method is listed twice" });
    const needs = new Set(m.shares.flatMap((s) => s.needs));
    for (const c of m.connect) {
      if (c.method === "token_fields") {
        const keys = c.fields.map((f) => f.key);
        if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "a field is listed twice" });
        const account = c.fields.find((f) => f.key === c.account);
        if (!account || account.secret) ctx.addIssue({ code: "custom", message: "account must name a field that is not secret" });
        const auth = c.fields.find((f) => f.key === c.auth.field);
        if (!auth || !auth.secret) ctx.addIssue({ code: "custom", message: "auth.field must name a secret field" });
        for (const p of c.permissions) if (!needs.has(p)) ctx.addIssue({ code: "custom", message: `the permission "${p}" has no shares line` });
      }
      if (c.method === "oauth_pkce") {
        for (const s of c.scopes) if (!needs.has(s)) ctx.addIssue({ code: "custom", message: `the scope ${s} has no shares line` });
      }
    }
    if (!m.shares.some((s) => s.direction === "never")) ctx.addIssue({ code: "custom", message: "shares needs a line saying what is never read or written" });
    const streams = m.produces.map((p) => p.stream);
    if (new Set(streams).size !== streams.length) ctx.addIssue({ code: "custom", message: "a stream is listed twice" });
  });

export type ConnectorManifest = z.infer<typeof ConnectorManifestSchema>;
export type ConnectorManifestInput = z.input<typeof ConnectorManifestSchema>;
export type ConnectMethod = z.infer<typeof ConnectMethodSchema>;
export type TokenFieldsMethod = Extract<ConnectMethod, { method: "token_fields" }>;
export type TokenField = z.infer<typeof TokenFieldSchema>;
export type ProducedStream = z.infer<typeof ProduceSchema>;

/** The first problem zod found, by path and rule. */
export function manifestIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.map(String).join(".") || "manifest"}: ${issue.message}` : "invalid";
}

/** Parse a manifest, or throw naming the connector and the first problem. */
export function parseManifest(input: unknown): ConnectorManifest {
  const parsed = ConnectorManifestSchema.safeParse(input);
  if (!parsed.success) {
    const id = input && typeof input === "object" && "id" in input ? String((input as { id: unknown }).id) : "unknown";
    throw new Error(`bad_connector_manifest:${id}:${manifestIssue(parsed.error)}`);
  }
  return parsed.data;
}

/** The token_fields method of a manifest, when it has one. */
export function tokenMethod(m: ConnectorManifest): TokenFieldsMethod | null {
  return (m.connect.find((c) => c.method === "token_fields") as TokenFieldsMethod | undefined) ?? null;
}

/** A stream of a manifest by name. */
export function streamOf(m: ConnectorManifest, stream: string): ProducedStream | null {
  return m.produces.find((p) => p.stream === stream) ?? null;
}
