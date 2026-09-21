import { z } from "zod";

/**
 * Product Connection — how a tenant connects THEIR product (e.g. vizzybl.ai) so
 * the platform understands the product's end users (who they are, which
 * onboarding steps they've done) and can run lifecycle journeys for them.
 *
 * Lives in the tenant-scoped `product_connections` collection (regional DB).
 * Three signed contracts hang off it (see src/lib/connect/protocol.ts):
 *  - ingest: the product POSTs identify/track events to /api/v1/events;
 *  - context: the platform POSTs to the product's context endpoint for fresh
 *    facts + insight candidates before an email;
 *  - webhook: the platform POSTs preference changes back to the product.
 * All three are signed with the connection's HMAC secret (sealed at rest, bound
 * to `${tenantId}:${id}` — see src/lib/connect/keys.ts). The public key id routes
 * unauthenticated ingest to this tenant via the control-plane `connection_keys`.
 */

/** Event names: lower-case dotted segments, e.g. `onboarding.step_completed`. */
export const EVENT_NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
/** Trait keys: a letter, then letters/digits/_/- (no dots — map keys stay flat). */
export const TRAIT_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** Onboarding step ids, e.g. `create_brand`. */
export const STEP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const ProductConnectionKind = z.enum(["custom", "sandbox"]);
export type ProductConnectionKind = z.infer<typeof ProductConnectionKind>;

export const ProductConnectionStatus = z.enum(["active", "paused", "revoked"]);
export type ProductConnectionStatus = z.infer<typeof ProductConnectionStatus>;

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
});
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;

export const GlossaryEntrySchema = z.object({
  term: z.string().min(1).max(80),
  definition: z.string().max(500),
});

/** What the product sends and means — powers condition fields and AI grounding. */
export const ConnectionCatalogSchema = z.object({
  events: z.array(CatalogEventSchema).max(100).default([]),
  traits: z.array(CatalogTraitSchema).max(100).default([]),
  onboardingSteps: z.array(OnboardingStepSchema).max(20).default([]),
  glossary: z.array(GlossaryEntrySchema).max(100).default([]),
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
  timeoutMs: z.number().int().min(500).max(5000).default(5000),
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
  consecutiveContextFailures: z.number().int().nonnegative().optional(),
});

export const ProductConnectionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string().min(1).max(120),
  kind: ProductConnectionKind,
  status: ProductConnectionStatus,
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
  catalog: ConnectionCatalogSchema,
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
