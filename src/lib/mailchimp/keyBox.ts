import { createSecretBox, type EncryptedBlob } from "@/lib/security/secretBox";
import type { MailchimpTenantConfig } from "@/lib/types/tenant";

/**
 * A brand's OWN Mailchimp API key (bring-your-own, see config.ts), sealed at rest
 * like every other stored credential: AES-256-GCM under its own root secret
 * `MAILCHIMP_KEY_ENC_KEY`, never shared with the git, social or connection keys.
 * The ciphertext is bound to its brand (AAD = tenantId), so a copy pasted onto
 * another brand's record won't open.
 *
 * MAILCHIMP_KEY_SEALED_ENABLED turns sealing on for saves. Reads understand both
 * forms whatever the switch says, so a key saved before it (plain `apiKey`) keeps
 * working until it is saved again or scripts/seal-mailchimp-keys.ts seals it.
 */
const box = createSecretBox({
  envVar: "MAILCHIMP_KEY_ENC_KEY",
  encPurpose: "mailchimp-key-v1",
  statePurpose: "mailchimp-state-v1",
  unconfiguredError: "mailchimp_key_enc_key_unconfigured",
});

export const MAILCHIMP_KEY_UNCONFIGURED = "mailchimp_key_enc_key_unconfigured";

export function isMailchimpKeySealingEnabled(): boolean {
  return process.env.MAILCHIMP_KEY_SEALED_ENABLED === "true";
}

export function isMailchimpKeyBoxConfigured(): boolean {
  return box.isConfigured();
}

export function sealMailchimpKey(tenantId: string, apiKey: string): EncryptedBlob {
  return box.seal(apiKey, tenantId);
}

export type OwnKeyRead = { ok: true; apiKey: string | null } | { ok: false };

/**
 * The brand's own key in plain text, from whichever form is stored (sealed wins).
 * `apiKey: null` = none saved. `ok: false` = a sealed key that won't open here:
 * the root secret is missing or different, or the blob belongs to another brand.
 */
export function readOwnMailchimpKey(
  tenantId: string,
  cfg: MailchimpTenantConfig | undefined,
): OwnKeyRead {
  if (cfg?.apiKeyEnc) {
    try {
      return { ok: true, apiKey: box.open(cfg.apiKeyEnc, tenantId).trim() || null };
    } catch {
      return { ok: false };
    }
  }
  return { ok: true, apiKey: cfg?.apiKey?.trim() || null };
}

export function hasOwnMailchimpKey(cfg: MailchimpTenantConfig | undefined): boolean {
  return Boolean(cfg?.apiKeyEnc) || Boolean(cfg?.apiKey?.trim());
}

/**
 * The key fields to store after a settings save. `input` undefined keeps what is
 * stored, blank clears it, anything else is the new key. With sealing on the
 * result never holds a plain key: a new key is sealed, and a plain key that is
 * kept gets sealed on the way through. A sealed key that is kept is carried over
 * as is, whatever the switch says.
 *
 * Throws MAILCHIMP_KEY_UNCONFIGURED when sealing is on but the root secret is
 * missing, so a save is refused rather than quietly stored in plain text.
 */
export function storedKeyFields(
  tenantId: string,
  existing: MailchimpTenantConfig | undefined,
  input: string | undefined,
  sealing: boolean,
): Pick<MailchimpTenantConfig, "apiKey" | "apiKeyEnc"> {
  if (input === undefined) {
    if (existing?.apiKeyEnc) return { apiKeyEnc: existing.apiKeyEnc };
    const kept = existing?.apiKey?.trim();
    if (!kept) return {};
    return sealing ? { apiKeyEnc: sealMailchimpKey(tenantId, kept) } : { apiKey: kept };
  }
  const next = input.trim();
  if (!next) return {};
  return sealing ? { apiKeyEnc: sealMailchimpKey(tenantId, next) } : { apiKey: next };
}
