import { getTenantById } from "@/lib/tenant";
import { resolveBrandVoiceText } from "./brandContext";

/**
 * The active brand-voice string for a generation, loaded server-side. Reads the tenant's authored
 * global voice and resolves it against the legacy per-workspace free text (see
 * `resolveBrandVoiceText` for precedence). One cached control-plane doc read; fail-soft (a missing
 * tenant falls back to the workspace voice). Text routes that don't already load the tenant use
 * this one-liner; image/layout routes that already loaded the tenant call `resolveBrandVoiceText`
 * directly with the in-scope `tenant.brandVoice` to avoid a second read.
 */
export async function activeBrandVoiceText(
  tenantId: string,
  workspaceBrandVoice?: string | null,
): Promise<string | null> {
  const tenant = await getTenantById(tenantId).catch(() => null);
  return resolveBrandVoiceText({
    tenantBrandVoice: tenant?.brandVoice,
    workspaceBrandVoice,
  });
}
