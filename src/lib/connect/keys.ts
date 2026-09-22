import { randomBytes } from "node:crypto";
import { createSecretBox, type EncryptedBlob } from "@/lib/security/secretBox";
import {
  forTenant,
  putConnectionKey,
  deleteConnectionKey,
  type TenantContext,
} from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import {
  ConnectionCatalogSchema,
  ConsentPolicySchema,
  type ConnectionCatalog,
  type ProductConnection,
  type ProductConnectionKind,
  type SandboxUser,
} from "@/lib/types/productConnection";

/**
 * Connection credentials: a PUBLIC key id (routes a request to its tenant, and is
 * the audience of the platform's outbound JWTs) and a SECRET that HMAC-signs the
 * events a product sends in. The platform's own requests to the product are NOT
 * signed with it (outboundToken.ts), so this store can't be used to forge them.
 * The secret is shown to the operator exactly once, then kept only
 * sealed (AES-256-GCM, AAD bound to `${tenantId}:${connectionId}`) under its own
 * root key, CONNECT_SECRET_ENC_KEY — never shared with git/social token keys.
 */
const box = createSecretBox({
  envVar: "CONNECT_SECRET_ENC_KEY",
  encPurpose: "connection-secret-v1",
  statePurpose: "connection-state-v1",
  unconfiguredError: "connect_enc_key_unconfigured",
});

export function isConnectCryptoConfigured(): boolean {
  return box.isConfigured();
}

/** How long the previous secret keeps verifying after a rotation. */
export const ROTATION_OVERLAP_MS = 24 * 3600_000;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A random lower-case base32 token of `chars` characters (5 bits each). */
function randomToken(chars: number): string {
  const bytes = randomBytes(chars);
  let out = "";
  for (let i = 0; i < chars; i += 1) out += BASE32[bytes[i]! & 31];
  return out;
}

export function newConnectionId(): string {
  return `pcn_${randomToken(20)}`;
}

export function newKeyId(): string {
  return `ygk_${randomToken(24)}`;
}

export function newSecret(): string {
  return `ygs_${randomBytes(32).toString("base64url")}`;
}

function secretAad(tenantId: string, connectionId: string): string {
  return `${tenantId}:${connectionId}`;
}

function sealSecret(tenantId: string, connectionId: string, secret: string): EncryptedBlob {
  return box.seal(secret, secretAad(tenantId, connectionId));
}

/** The prefix shown in the UI so an operator can tell secrets apart. */
function prefixOf(secret: string): string {
  return secret.slice(0, 10);
}

/**
 * The plaintext secrets a signature may verify against: the current one, plus
 * the previous one while its rotation overlap lasts. Empty once revoked.
 */
export function connectionSecrets(conn: ProductConnection, nowMs = Date.now()): string[] {
  const out: string[] = [];
  if (conn.secretEnc) out.push(box.open(conn.secretEnc, secretAad(conn.tenantId, conn.id)));
  if (
    conn.prevSecretEnc &&
    conn.prevSecretExpiresAt &&
    Date.parse(conn.prevSecretExpiresAt) > nowMs
  ) {
    out.push(box.open(conn.prevSecretEnc, secretAad(conn.tenantId, conn.id)));
  }
  return out;
}

/** The current secret only — what the sandbox signs the events it fires with. */
export function currentSecret(conn: ProductConnection): string | null {
  return conn.secretEnc ? box.open(conn.secretEnc, secretAad(conn.tenantId, conn.id)) : null;
}

export interface CreateConnectionInput {
  name: string;
  kind: ProductConnectionKind;
  catalog?: Partial<ConnectionCatalog>;
  sandboxUsers?: SandboxUser[];
  createdBy?: string | null;
}

/**
 * Create a connection and register its key. The regional record is written
 * FIRST, then the control-plane key routing: if the second write fails, the
 * connection just has no working key (the operator can rotate/recreate).
 * Returns the plaintext secret — the ONLY time it is ever returned.
 */
export async function createConnection(
  ctx: TenantContext,
  input: CreateConnectionInput,
  db?: FirestoreLike,
): Promise<{ connection: ProductConnection; secret: string }> {
  const id = newConnectionId();
  const keyId = newKeyId();
  const secret = newSecret();
  const now = new Date().toISOString();
  const connection = await forTenant(ctx, db).productConnections.create(id, {
    name: input.name.trim(),
    kind: input.kind,
    status: "active",
    keyId,
    secretEnc: sealSecret(ctx.tenantId, id, secret),
    secretPrefix: prefixOf(secret),
    prevSecretEnc: null,
    prevSecretExpiresAt: null,
    contextEndpoint: null,
    webhookEndpoint: null,
    linkDomains: [],
    catalog: ConnectionCatalogSchema.parse(input.catalog ?? {}),
    consentPolicy: ConsentPolicySchema.parse({}),
    defaults: { timezone: "Europe/London", locale: "en" },
    health: {},
    sandbox: input.kind === "sandbox" ? { users: input.sandboxUsers ?? [], webhookInbox: [] } : null,
    createdBy: input.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  });
  await putConnectionKey(
    { keyId, tenantId: ctx.tenantId, region: ctx.region, connectionId: id, createdAt: now },
    db,
  );
  return { connection, secret };
}

/**
 * Issue a new secret. The previous one keeps verifying for ROTATION_OVERLAP_MS so
 * the product can switch without dropping events. The key id is unchanged.
 * Returns null when the connection is missing or revoked.
 */
export async function rotateConnectionSecret(
  ctx: TenantContext,
  connectionId: string,
  db?: FirestoreLike,
  nowMs = Date.now(),
): Promise<{ secret: string } | null> {
  const secret = newSecret();
  const updated = await forTenant(ctx, db).productConnections.claim(connectionId, (cur) => {
    if (cur.status === "revoked" || !cur.secretEnc) return null;
    return {
      secretEnc: sealSecret(ctx.tenantId, connectionId, secret),
      secretPrefix: prefixOf(secret),
      prevSecretEnc: cur.secretEnc,
      prevSecretExpiresAt: new Date(nowMs + ROTATION_OVERLAP_MS).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
    };
  });
  return updated ? { secret } : null;
}

/**
 * Revoke a connection: its key routing is deleted FIRST (ingest stops at once,
 * bounded by the resolver cache), then the secrets are destroyed. The record is
 * kept, status "revoked", for audit. Returns false when it doesn't exist.
 */
export async function revokeConnection(
  ctx: TenantContext,
  connectionId: string,
  db?: FirestoreLike,
): Promise<boolean> {
  const repo = forTenant(ctx, db).productConnections;
  const conn = await repo.getById(connectionId);
  if (!conn) return false;
  await deleteConnectionKey(conn.keyId, ctx.tenantId, db);
  await repo.update(connectionId, {
    status: "revoked",
    secretEnc: null,
    prevSecretEnc: null,
    prevSecretExpiresAt: null,
    updatedAt: new Date().toISOString(),
  });
  return true;
}
