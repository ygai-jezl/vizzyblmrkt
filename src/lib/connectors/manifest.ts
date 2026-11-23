import { z } from "zod";
import { MEANINGS } from "@/lib/metrics/meanings";
import { isTimeZone } from "./period";

/**
 * The connector manifest: what a connector is, how it signs in, which hosts it may call, what it
 * reads and what it produces, as pure data. The same file works whether YouGrow writes it, a
 * contributor sends it or (later) a vendor publishes it, so it holds no functions: code a
 * connector needs is named by a hook id (`<connector>.<name>`) and lives in
 * src/lib/connectors/handlers. src/lib/connectors/manifest.test.ts checks every manifest parses,
 * survives a JSON round trip and writes in house style.
 *
 * Fields, in the order of the plan's design:
 * - connect: the sign-in methods: token_fields (connectors 1a), oauth_pkce, Sign in with Google
 *   (1b), and share_access, a Google address made for the connection (1c).
 * - api: every outbound call. Only these hosts are reachable, under these limits
 *   (src/lib/connectors/safeFetch.ts enforces them).
 * - verify: the one request that proves a connection works, run before anything is saved.
 * - shares: what we read or write, in plain words. Every permission or scope a sign-in asks for
 *   has a line that names it.
 * - produces: each stream for people and agents: its shape, keys, the meaning of every number
 *   (a MEANINGS key) and the shared keys it joins on.
 * - uses: what it plugs into in YouGrow.
 * - hooks: named handler ids, never functions: live reads a stream, and accounts lists what a
 *   signed in connection or a pasted token can see, for the picker.
 * - icon: the connector's own mark, as files on YouGrow's own site under
 *   public/marks/connectors/<id>/ (never a link to the vendor's host), with whoever owns it.
 *   Without one, the screens show the two letters.
 */

/**
 * Ids the routes and pages use beside /connectors/[connectorId] and the Settings pages beside
 * /admin/account/connections/[connectorId] (Browse and Connected), so no connector may take them.
 */
export const RESERVED_CONNECTOR_IDS = ["browse", "callback", "connections", "connected"] as const;

export const CONNECT_METHODS = ["token_fields", "oauth_pkce", "share_access"] as const;
export type ConnectMethodName = (typeof CONNECT_METHODS)[number];

/**
 * What a connector is about, kept fine grained in the manifest. Browse groups them only for display
 * (src/components/admin/connectors/words.ts, CATEGORY_GROUPS): analytics and search under "Search
 * and analytics", traffic under "Website and traffic".
 */
export const CONNECTOR_CATEGORIES = ["analytics", "search", "traffic", "social", "email", "code", "crm", "shop"] as const;
export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number];
export const STREAM_SHAPES = ["numbers", "events", "records", "text"] as const;
/** The shared keys a stream may join on (ontology rule: one way of writing each). */
export const JOIN_KEYS = ["day", "page", "topic", "person", "company", "idea"] as const;
export type JoinKey = (typeof JOIN_KEYS)[number];
/** The fixed list of dimensions a live read may group by. */
export const LIVE_BY = ["day", "page", "topic", "landing"] as const;
export type LiveBy = (typeof LIVE_BY)[number];
/** The shared key each grouping's rows join on: a landing page is a page. */
export const LIVE_BY_JOINS: Readonly<Record<LiveBy, JoinKey>> = { day: "day", page: "page", topic: "topic", landing: "page" };
/** The filters a live read may use, where its stream lists them: one page path, matched exactly. */
export const LIVE_FILTERS = ["page"] as const;
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

/**
 * A file of a connector's marks, served from YouGrow's own site: /marks/connectors/<id>/<name>,
 * an svg or png, lower case, with no dots or slashes in the name. The manifest checks the folder
 * is the connector's own; src/lib/connectors/marks.test.ts checks every file is there and safe.
 */
const MarkPath = z.string().regex(/^\/marks\/connectors\/[a-z][a-z0-9-]{1,39}\/[a-z0-9][a-z0-9-]{0,39}\.(?:svg|png)$/, "an svg or png under /marks/connectors/<id>/");

/**
 * A connector's marks: its square icon for tiles and rows, on a light background (and a file for
 * dark backgrounds when its owner gives one), who owns it, and a wide logo with its name where the
 * owner asks for one linked to them (Google Analytics wherever an app shows its data). The screens
 * keep the name beside every mark, so its alt text is empty; the wide logo is a link, so its alt
 * says the words in the image.
 */
export const ConnectorIconSchema = z
  .object({
    light: MarkPath,
    dark: MarkPath.optional(),
    /** Whose trademark it is, for the notice beside the files (public/marks/NOTICE.md). */
    owner: Copy(80),
    lockup: z
      .object({
        light: MarkPath,
        dark: MarkPath.optional(),
        /** The owner's product page, which the logo links to. */
        href: HttpsUrl,
        alt: Copy(60),
        /** Its size on screen, in CSS pixels: at least the owner's minimum. */
        width: z.number().int().min(16).max(400),
        height: z.number().int().min(16).max(200),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ConnectorIcon = z.infer<typeof ConnectorIconSchema>;

/** Every file a connector's marks name. */
export function iconFiles(icon: ConnectorIcon): string[] {
  return [icon.light, icon.dark, icon.lockup?.light, icon.lockup?.dark].filter((p): p is string => typeof p === "string");
}

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
    /**
     * Pick the account from a list after Check, where the token can list them (hooks.accounts):
     * the list's label, and the short note shown when the token can't list them, so the account
     * field is typed instead. Without it, every field is typed and Connect checks them together.
     */
    pick: z.object({ label: Copy(60), cantList: Copy(200) }).strict().optional(),
  })
  .strict();

const OAuthMethodSchema = z
  .object({
    method: z.literal("oauth_pkce"),
    client: z.literal("google"),
    /** One scope per connection (decision 3 of the Connectors 1 plan). */
    scopes: z.array(HttpsUrl).length(1),
    /**
     * A switch of its own that holds this sign in back, for a scope Google treats as sensitive:
     * Sign in waits for Google's review of the app while share access can go on. Read through
     * src/lib/connectors/flags.ts; the registry refuses a switch nothing reads.
     */
    switch: z
      .string()
      .regex(/^CONNECTOR_[A-Z0-9_]+_ENABLED$/)
      .optional(),
  })
  .strict();

/**
 * Share access (Connectors 1c): the admin adds a Google address made for this one connection as a
 * user of their property, with this role, and YouGrow reads with a short lived token for that
 * address with only this scope. Needs the identities project (CONNECTORS_IDENTITIES_PROJECT).
 */
const ShareAccessMethodSchema = z
  .object({
    method: z.literal("share_access"),
    google: z.enum(["search-console", "ga4"]),
    /** The role to give the connection's own address, in the product's words. */
    role: Copy(60),
    /** The one read scope its tokens carry. */
    scopes: z.array(HttpsUrl).length(1),
    /** Where to add the address, step by step, in the product's words. */
    steps: z.array(Copy()).min(1).max(8),
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
    /**
     * The IANA time zone the provider's days are in, when it is fixed (Search Console: Pacific
     * time; Cloudflare: UTC). Without it, the hook learns the zone from each answer (a Google
     * Analytics property's own zone). "today" for a read is worked out in this zone.
     */
    timeZone: z.string().refine(isTimeZone, "an IANA time zone such as America/Los_Angeles").optional(),
    /** How a read's days match the provider's own report, in plain words, for people and agents. */
    days: Copy().optional(),
    /** True when a row is about a person. Refused until the data processing agreement covers it. */
    personal: z.boolean(),
    /** The dimensions a live read of this stream may group by. */
    liveBy: z.array(z.enum(LIVE_BY)).min(1).max(LIVE_BY.length),
    /** The filters a live read of this stream may use. */
    liveFilters: z.array(z.enum(LIVE_FILTERS)).max(LIVE_FILTERS.length).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.shape === "numbers" && p.measures.length === 0) ctx.addIssue({ code: "custom", message: "a numbers stream needs at least one measure" });
    if (p.shape !== "numbers" && p.measures.length > 0) ctx.addIssue({ code: "custom", message: "only a numbers stream has measures" });
    for (const k of Object.keys(p.joins)) {
      if (!p.keys.includes(k)) ctx.addIssue({ code: "custom", message: `joins names ${k}, which is not one of its keys` });
    }
    for (const by of p.liveBy) {
      if (!Object.values(p.joins).includes(LIVE_BY_JOINS[by])) ctx.addIssue({ code: "custom", message: `liveBy ${by} has no key that joins on it` });
    }
    for (const f of p.liveFilters ?? []) {
      if (!Object.values(p.joins).includes(f)) ctx.addIssue({ code: "custom", message: `liveFilters ${f} has no key that joins on it` });
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
    /**
     * The two letters on its tile on Browse and its Listing, when its words' first letters aren't
     * them (Cloudflare is CF, as the approved screens). Without it the screens work them out.
     */
    initials: z.string().regex(/^[A-Z0-9]{2}$/, "two capital letters or digits").optional(),
    /** Its own marks, shown beside its name; the two letters stay the fallback. */
    icon: ConnectorIconSchema.optional(),
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
    /**
     * live reads a stream; accounts lists what a signed in connection, or a pasted token before
     * it is saved, can see (sites, properties, zones), for the picker. A connection that signs in
     * needs accounts, and so does a token method that picks from a list.
     */
    hooks: z.object({ live: HookId, accounts: HookId.optional() }).strict(),
    /** What Disconnect can and can't do at the provider, for the screen and help. */
    disconnect: Copy(),
  })
  .strict()
  .superRefine((m, ctx) => {
    const hostOf = (u: string) => new URL(u).hostname;
    for (const file of m.icon ? iconFiles(m.icon) : []) {
      if (!file.startsWith(`/marks/connectors/${m.id}/`)) ctx.addIssue({ code: "custom", path: ["icon"], message: `${file} is not in the connector's own folder, /marks/connectors/${m.id}/` });
    }
    if (!m.api.hosts.includes(hostOf(m.verify.url))) ctx.addIssue({ code: "custom", message: "verify.url is not on a declared host" });
    for (const hook of [m.verify.hook, m.hooks.live, ...(m.hooks.accounts ? [m.hooks.accounts] : [])]) {
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
        // A connection stores its account and its sealed secrets, nothing else a person typed.
        for (const f of c.fields) if (!f.secret && f.key !== c.account) ctx.addIssue({ code: "custom", message: `${f.key} is neither the account nor a secret` });
        const auth = c.fields.find((f) => f.key === c.auth.field);
        if (!auth || !auth.secret) ctx.addIssue({ code: "custom", message: "auth.field must name a secret field" });
        for (const p of c.permissions) if (!needs.has(p)) ctx.addIssue({ code: "custom", message: `the permission "${p}" has no shares line` });
        // Picking from a list needs the hook that lists what the token can see.
        if (c.pick && !m.hooks.accounts) ctx.addIssue({ code: "custom", message: "token_fields pick needs hooks.accounts, the list" });
      }
      if (c.method === "oauth_pkce" || c.method === "share_access") {
        for (const s of c.scopes) if (!needs.has(s)) ctx.addIssue({ code: "custom", message: `the scope ${s} has no shares line` });
      }
      // A sign in or a shared address can see many sites or properties: an admin picks one.
      if ((c.method === "oauth_pkce" || c.method === "share_access") && !m.hooks.accounts) {
        ctx.addIssue({ code: "custom", message: `${c.method} needs hooks.accounts, the picker` });
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
export type OAuthMethod = Extract<ConnectMethod, { method: "oauth_pkce" }>;
export type ShareAccessMethod = Extract<ConnectMethod, { method: "share_access" }>;
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

/** The oauth_pkce method of a manifest, when it has one. */
export function oauthMethod(m: ConnectorManifest): OAuthMethod | null {
  return (m.connect.find((c) => c.method === "oauth_pkce") as OAuthMethod | undefined) ?? null;
}

/** The share_access method of a manifest, when it has one. */
export function shareMethod(m: ConnectorManifest): ShareAccessMethod | null {
  return (m.connect.find((c) => c.method === "share_access") as ShareAccessMethod | undefined) ?? null;
}

/** The token_fields method of a manifest, when it has one. */
export function tokenMethod(m: ConnectorManifest): TokenFieldsMethod | null {
  return (m.connect.find((c) => c.method === "token_fields") as TokenFieldsMethod | undefined) ?? null;
}

/** A stream of a manifest by name. */
export function streamOf(m: ConnectorManifest, stream: string): ProducedStream | null {
  return m.produces.find((p) => p.stream === stream) ?? null;
}
