import { createSecretBox, type EncryptedBlob } from "@/lib/security/secretBox";

/**
 * The connector vault (decision 32): every secret a connection keeps (an API token now, OAuth
 * tokens with Connectors 1b) is sealed here with AES-256-GCM under its own root key,
 * CONNECTORS_VAULT_KEY, never shared with the git, social, connection or Mailchimp keys.
 *
 * - AAD is `${tenantId}:${connectionId}:${slot}`, so a blob copied onto another brand, another
 *   connection or another slot will not open. An organisation's connection (Connectors 3,
 *   ADR-0014) binds `${organisationId}:${ocn id}:${slot}` in the same format: brand ids start
 *   `ten_` and organisation ids `org_`, so a blob sealed for one never opens as the other.
 * - Each blob stores `encKeyId`, the root key's short id (secretBox keyId under the label
 *   connector-key-id). `keyId` already means a connection key's ygk_ id elsewhere, hence the name.
 * - Rotation: move the current root to CONNECTORS_VAULT_KEY_PREVIOUS and set a new one. Blobs
 *   whose encKeyId matches the previous root still open; every new seal uses the current root;
 *   scripts/reseal-connector-secrets.ts moves the rest. Remove the previous root only when the
 *   reseal dry run counts zero blobs on its id, or those tokens can never be opened again.
 * - Saving with no root key is refused (VAULT_UNCONFIGURED), as the Mailchimp key box does.
 *
 * Plain text is never logged, returned to a browser or sent to Vizzy.
 */

export const VAULT_UNCONFIGURED = "connectors_vault_key_unconfigured";
const PREVIOUS_UNCONFIGURED = "connectors_vault_previous_key_unconfigured";
const KEY_ID_LABEL = "connector-key-id";

const current = createSecretBox({
  envVar: "CONNECTORS_VAULT_KEY",
  encPurpose: "connector-secret-v1",
  statePurpose: "connector-state-v1",
  unconfiguredError: VAULT_UNCONFIGURED,
});

const previous = createSecretBox({
  envVar: "CONNECTORS_VAULT_KEY_PREVIOUS",
  encPurpose: "connector-secret-v1",
  statePurpose: "connector-state-v1",
  unconfiguredError: PREVIOUS_UNCONFIGURED,
});

/** A sealed secret as stored on a connection, one per slot. */
export interface SealedSecret {
  blob: EncryptedBlob;
  /** The short id of the root key that sealed it. */
  encKeyId: string;
  sealedAt: string;
}

/** Why a blob would not open: no root key matches its id, or the blob or its binding is wrong. */
export type OpenFailure = "unknown_key" | "unopenable";

export class VaultOpenError extends Error {
  constructor(readonly why: OpenFailure) {
    super(`connector_secret_${why}`);
  }
}

/**
 * Sign a sign in's state (Connectors 1b) with the vault's own state key, connector-state-v1, so
 * it shares nothing with the git or social signers. Throws VAULT_UNCONFIGURED when unset.
 */
export function signConnectorState(payload: Record<string, unknown>): string {
  if (!current.isConfigured()) throw new Error(VAULT_UNCONFIGURED);
  return current.signState(payload);
}

/** The payload of a state this vault signed, or null (never throws, including after a rotation). */
export function verifyConnectorState(token: string): Record<string, unknown> | null {
  return current.verifyState(token);
}

/** True when the current root key is set, so a secret can be saved. */
export function isVaultConfigured(): boolean {
  return current.isConfigured();
}

/** The current root key's id, or null when it is unset. */
export function currentVaultKeyId(): string | null {
  return current.isConfigured() ? current.keyId(KEY_ID_LABEL) : null;
}

/** The previous root key's id while a rotation is under way, or null. */
export function previousVaultKeyId(): string | null {
  return previous.isConfigured() ? previous.keyId(KEY_ID_LABEL) : null;
}

/** What binds a blob to its place. */
export function vaultAad(tenantId: string, connectionId: string, slot: string): string {
  if (!tenantId || !connectionId || !slot || [tenantId, connectionId, slot].some((p) => p.includes(":"))) {
    throw new Error("bad_vault_binding");
  }
  return `${tenantId}:${connectionId}:${slot}`;
}

/** Seal a secret under the current root. Throws VAULT_UNCONFIGURED when it is unset. */
export function sealConnectorSecret(tenantId: string, connectionId: string, slot: string, plaintext: string, now = new Date()): SealedSecret {
  if (!current.isConfigured()) throw new Error(VAULT_UNCONFIGURED);
  return {
    blob: current.seal(plaintext, vaultAad(tenantId, connectionId, slot)),
    encKeyId: current.keyId(KEY_ID_LABEL),
    sealedAt: now.toISOString(),
  };
}

/**
 * Open a sealed secret with the root its encKeyId names: the current one, or the previous one
 * during a rotation. Throws VaultOpenError("unknown_key") when neither root matches, and
 * VaultOpenError("unopenable") when the blob or its binding is wrong.
 */
export function openConnectorSecret(tenantId: string, connectionId: string, slot: string, sealed: SealedSecret): string {
  const aad = vaultAad(tenantId, connectionId, slot);
  const box = sealed.encKeyId === currentVaultKeyId() ? current : sealed.encKeyId === previousVaultKeyId() ? previous : null;
  if (!box) throw new VaultOpenError("unknown_key");
  try {
    return box.open(sealed.blob, aad);
  } catch {
    throw new VaultOpenError("unopenable");
  }
}

/** True when a sealed secret is on the current root already. */
export function isOnCurrentKey(sealed: SealedSecret): boolean {
  return sealed.encKeyId === currentVaultKeyId();
}

export type ResealOutcome =
  | { ok: true; sealed: SealedSecret; changed: boolean }
  | { ok: false; why: OpenFailure | "unconfigured" | "round_trip_mismatch" };

/**
 * Seal a secret again under the current root, for key rotation. The new blob is opened and
 * compared with the old plain text before it is returned, so a reseal can never store a blob
 * that doesn't open. A blob already on the current root comes back unchanged. Never throws.
 */
export function resealConnectorSecret(tenantId: string, connectionId: string, slot: string, sealed: SealedSecret, now = new Date()): ResealOutcome {
  if (!current.isConfigured()) return { ok: false, why: "unconfigured" };
  if (isOnCurrentKey(sealed)) return { ok: true, sealed, changed: false };
  let plain: string;
  try {
    plain = openConnectorSecret(tenantId, connectionId, slot, sealed);
  } catch (err) {
    return { ok: false, why: err instanceof VaultOpenError ? err.why : "unopenable" };
  }
  const next = sealConnectorSecret(tenantId, connectionId, slot, plain, now);
  try {
    if (openConnectorSecret(tenantId, connectionId, slot, next) !== plain) return { ok: false, why: "round_trip_mismatch" };
  } catch {
    return { ok: false, why: "round_trip_mismatch" };
  }
  return { ok: true, sealed: next, changed: true };
}
