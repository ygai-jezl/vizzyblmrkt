import { z } from "zod";

/**
 * Product Connection — how a tenant connects THEIR product (e.g. vizzybl.ai) so
 * the platform understands the product's end users (who they are, which
 * onboarding steps they've done) and can run lifecycle journeys for them.
 *
 * Lives in the tenant-scoped `product_connections` collection (regional DB).
 * Three contracts hang off it:
 *  - API v2 (src/lib/connect/v2/contract.ts): the product sends each user's
 *    state to /api/v2/users…, authenticated with HTTP Basic — the public key id
 *    (routed to this tenant via the control-plane `connection_keys`) and the
 *    connection's secret (sealed at rest, bound to `${tenantId}:${id}` — see
 *    src/lib/connect/keys.ts);
 *  - context (optional): the platform POSTs to the product's context endpoint
 *    for fresh facts + insight candidates before an email;
 *  - webhook (optional): the platform POSTs preference changes back.
 * Context pulls and webhooks carry the platform's own signed JWT
 * (src/lib/connect/outboundToken.ts) — never anything derived from the secret.
 */

/** Event names: lower-case dotted segments, e.g. `onboarding.step_completed`. */
export const EVENT_NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
/** Trait keys: a letter, then letters/digits/_/- (no dots — map keys stay flat). */
export const TRAIT_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** Onboarding step ids, e.g. `create_brand`. */
export const STEP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** An entity kind: the product's own word for a thing people have several of, e.g. `brand`. */
export const ENTITY_KIND_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** Which entity kind a catalog step, fact or event belongs to; absent or null = the person. */
const EntityKindRef = z.string().regex(ENTITY_KIND_RE).nullable().optional();

export const ProductConnectionKind = z.enum(["custom", "sandbox"]);
export type ProductConnectionKind = z.infer<typeof ProductConnectionKind>;

export const ProductConnectionStatus = z.enum(["active", "paused", "revoked"]);
export type ProductConnectionStatus = z.infer<typeof ProductConnectionStatus>;

/** Which copy of the product a connection is (see src/lib/connect/environments.ts). */
export const ProductEnvironment = z.enum(["staging", "production"]);

/**
 * The legal basis the PRODUCT asserts for emailing a user (UK PECR framing).
 * `corporate_subscriber` = a business address; `soft_opt_in` = an existing
 * customer notified at signup with a refusal option; `consent` = explicit
 * opt-in; `none` = no basis (service messages only).
 */
export const ConsentBasis = z.enum(["consent", "soft_opt_in", "corporate_subscriber", "none"]);
export type ConsentBasis = z.infer<typeof ConsentBasis>;

export const EncryptedBlobSchema = z.object({
  ct: z.string(),
  iv: z.string(),
  tag: z.string(),
});

export const CatalogEventSchema = z.object({
  name: z.string().max(80).regex(EVENT_NAME_RE),
  label: z.string().max(120).default(""),
  description: z.string().max(500).default(""),
  /** The entity kind it happens to, e.g. `audit.completed` → `brand`. */
  kind: EntityKindRef,
});
export type CatalogEvent = z.infer<typeof CatalogEventSchema>;

export const TraitType = z.enum(["string", "number", "boolean", "timestamp"]);
export type TraitType = z.infer<typeof TraitType>;

export const CatalogTraitSchema = z.object({
  key: z.string().regex(TRAIT_KEY_RE),
  type: TraitType,
  label: z.string().max(120).default(""),
  description: z.string().max(500).default(""),
});
export type CatalogTrait = z.infer<typeof CatalogTraitSchema>;

export const OnboardingStepSchema = z.object({
  id: z.string().regex(STEP_ID_RE),
  label: z.string().min(1).max(120),
  /** Deep link into the product that completes the step. */
  url: z.string().max(2000).nullable().optional(),
  order: z.number().int().min(0).max(100),
  /** How the product decides the step is done (plain words, for people and the AI). */
  completion: z.string().max(500).optional(),
  /** Done per entity of this kind (e.g. per brand) rather than once per person. */
  kind: EntityKindRef,
});
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;

/** Fact ids match the `id` of facts the product returns from its context endpoint. */
export const FACT_ID_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const FactType = z.enum(["number", "string", "boolean"]);

/**
 * A number (or value) the product can report about one user — the raw material
 * for insights and for branching ("share of voice below 10%"). Values arrive
 * per user from the context endpoint; the catalog says what exists and means.
 */
export const CatalogFactSchema = z.object({
  id: z.string().regex(FACT_ID_RE),
  label: z.string().min(1).max(120),
  type: FactType.default("number"),
  unit: z.string().max(20).nullable().optional(),
  description: z.string().max(500).default(""),
  /** Where the product gets it (plain words), e.g. "daily visibility snapshot". */
  source: z.string().max(500).default(""),
  /** Who has it, when not everyone does, e.g. "brands with a product catalogue" — the rest send nothing. */
  appliesWhen: z.string().max(200).optional(),
  /** A value per entity of this kind (e.g. share of voice per brand) rather than per person. */
  kind: EntityKindRef,
});
export type CatalogFact = z.infer<typeof CatalogFactSchema>;

/**
 * A kind of thing people have several of in the product — workspaces, brands,
 * projects — as the product names it. Learned from the repo or added by hand;
 * users send them as `entities`, and journeys say which of them an email is about.
 */
export const CatalogEntityKindSchema = z.object({
  kind: z.string().regex(ENTITY_KIND_RE),
  /** Singular and plural, for emails and the admin: "brand" / "brands". */
  label: z.string().min(1).max(40),
  plural: z.string().min(1).max(40),
  /** The kind it sits inside, e.g. a brand's `workspace`. */
  parent: z.string().regex(ENTITY_KIND_RE).nullable().optional(),
  /** One person can have several. */
  multiple: z.boolean().default(true),
  description: z.string().max(300).default(""),
});
export type CatalogEntityKind = z.infer<typeof CatalogEntityKindSchema>;

export const GlossaryEntrySchema = z.object({
  term: z.string().min(1).max(80),
  definition: z.string().max(500),
});

/** What the product sends and means — powers condition fields and AI grounding. */
export const ConnectionCatalogSchema = z.object({
  events: z.array(CatalogEventSchema).max(100).default([]),
  traits: z.array(CatalogTraitSchema).max(100).default([]),
  onboardingSteps: z.array(OnboardingStepSchema).max(20).default([]),
  facts: z.array(CatalogFactSchema).max(50).default([]),
  glossary: z.array(GlossaryEntrySchema).max(100).default([]),
  entityKinds: z.array(CatalogEntityKindSchema).max(10).default([]),
});
export type ConnectionCatalog = z.infer<typeof ConnectionCatalogSchema>;

export const ConsentPolicySchema = z.object({
  /** Bases that allow MARKETING-class lifecycle email (service messages need none). */
  marketingBases: z
    .array(ConsentBasis)
    .default(["consent", "soft_opt_in", "corporate_subscriber"]),
  /** Treat `corporate_subscriber` as `none` for public email domains (gmail…). */
  verifyCorporateDomain: z.boolean().default(true),
});
export type ConsentPolicy = z.infer<typeof ConsentPolicySchema>;

export const ContextEndpointSchema = z.object({
  url: z.string().max(2000),
  /** Per pull. The default is 2 s: a cold start or a slow lookup falls back to stored state rather than holding up sends. */
  timeoutMs: z.number().int().min(500).max(5000).default(2000),
  enabled: z.boolean().default(false),
});

export const WebhookEndpointSchema = z.object({
  url: z.string().max(2000),
  enabled: z.boolean().default(false),
});

/** A sandbox test user: the reference context endpoint serves these facts. */
export const SandboxUserSchema = z.object({
  userId: z.string().min(1).max(256),
  email: z.string().email().max(254),
  firstName: z.string().max(100).nullable().optional(),
  timezone: z.string().max(64).default("Europe/London"),
  /** Step id → done. */
  steps: z.record(z.string(), z.boolean()).default({}),
  facts: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        label: z.string().min(1).max(120),
        value: z.union([z.string().max(200), z.number(), z.boolean()]),
        unit: z.string().max(20).nullable().optional(),
      }),
    )
    .max(20)
    .default([]),
  insights: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        sentence: z.string().min(1).max(300),
        factIds: z.array(z.string().max(64)).max(10).default([]),
        weight: z.number().min(0).max(1).default(0.5),
        supportsStep: z.string().max(64).nullable().optional(),
      }),
    )
    .max(10)
    .default([]),
});
export type SandboxUser = z.infer<typeof SandboxUserSchema>;

/** A signed webhook the sandbox's reference receiver accepted (for display). */
export const SandboxWebhookSchema = z.object({
  receivedAt: z.string(),
  type: z.string().max(80),
  body: z.string().max(4000),
});

export const ConnectionHealthSchema = z.object({
  lastEventAt: z.string().nullable().optional(),
  lastContextOkAt: z.string().nullable().optional(),
  lastContextError: z.string().max(200).nullable().optional(),
  /** When the last pull failed — with the count below, it opens the runner's breaker. */
  lastContextErrorAt: z.string().nullable().optional(),
  consecutiveContextFailures: z.number().int().nonnegative().optional(),
});

export const ProductConnectionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string().min(1).max(120),
  kind: ProductConnectionKind,
  status: ProductConnectionStatus,
  /**
   * Staging or production copy of the product. Absent on connections made before
   * environments existed — those are inferred from their name ("App (staging)").
   */
  environment: ProductEnvironment.nullable().optional(),
  /** Public key id sent as X-YouGrow-Key-Id; routes ingest via connection_keys. */
  keyId: z.string(),
  /** The HMAC secret, sealed with AAD `${tenantId}:${id}`. Null once revoked. */
  secretEnc: EncryptedBlobSchema.nullable(),
  /** First characters of the secret, shown so an operator can tell keys apart. */
  secretPrefix: z.string(),
  /** Previous secret during a rotation, valid until prevSecretExpiresAt. */
  prevSecretEnc: EncryptedBlobSchema.nullable().optional(),
  prevSecretExpiresAt: z.string().nullable().optional(),
  contextEndpoint: ContextEndpointSchema.nullable().optional(),
  webhookEndpoint: WebhookEndpointSchema.nullable().optional(),
  /** Registrable domains that product-supplied links (step URLs) may point at. */
  linkDomains: z.array(z.string().max(253)).max(20).default([]),
  /**
   * Where invited waitlist members sign up (nav v2 phase 4 invites). https only,
   * and on one of `linkDomains`. Invite links redirect here with `yg_invite=<code>`.
   */
  signupUrl: z.string().url().max(2000).nullable().optional(),
  catalog: ConnectionCatalogSchema,
  /**
   * Bumped by every catalog change. A save names the one it started from and is
   * refused when they differ, so an older copy (another tab) can't overwrite a
   * newer catalog. Absent (= 0) until the catalog first changes after this existed.
   */
  catalogRev: z.number().int().nonnegative().optional(),
  consentPolicy: ConsentPolicySchema,
  defaults: z.object({
    timezone: z.string().max(64).default("Europe/London"),
    locale: z.string().max(16).default("en"),
  }),
  health: ConnectionHealthSchema.default({}),
  /** Sandbox connections only: test users and the webhook inbox. */
  sandbox: z
    .object({
      users: z.array(SandboxUserSchema).max(10).default([]),
      webhookInbox: z.array(SandboxWebhookSchema).max(20).default([]),
    })
    .nullable()
    .optional(),
  createdBy: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProductConnection = z.infer<typeof ProductConnectionSchema>;
