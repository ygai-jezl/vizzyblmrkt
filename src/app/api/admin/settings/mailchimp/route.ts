import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { getTenantById, getTenantsByMailchimpAudience, updateTenantConfig } from "@/lib/tenant";
import {
  MAILCHIMP_KEY_UNCONFIGURED,
  hasOwnMailchimpKey,
  isMailchimpKeySealingEnabled,
  readOwnMailchimpKey,
  storedKeyFields,
} from "@/lib/mailchimp/keyBox";
import { getAudience } from "@/lib/mailchimp/client";
import { deriveServerPrefix } from "@/lib/mailchimp/config";
import { isMailchimpServerPrefix } from "@/lib/mailchimp/serverPrefix";
import type { MailchimpTenantConfig } from "@/lib/types/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SettingsSchema = z.object({
  requiresOwnApiKey: z.boolean(),
  // Omitted → keep existing; empty string → clear. Never echoed back.
  apiKey: z.string().optional(),
  audienceId: z.string().optional(),
  serverPrefix: z.string().optional(),
});

/** Read the tenant's MailChimp config (the key itself is never returned). */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const tenant = await getTenantById(ctx.tenantId);
  const cfg = tenant?.mailchimpConfig;
  return NextResponse.json({
    requiresOwnApiKey: cfg?.requiresOwnApiKey ?? false,
    apiKeySet: hasOwnMailchimpKey(cfg),
    apiKeySealed: Boolean(cfg?.apiKeyEnc),
    audienceId: cfg?.audienceId ?? null,
    serverPrefix: cfg?.serverPrefix ?? null,
  });
}

const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

/**
 * Why a new audience id can't be claimed by this brand, or null when it can. The webhook
 * routes an audience's unsubscribes, bounces and spam reports to the brand that holds its
 * id, so a brand may only claim an audience it proves it owns: not the shared one, not one
 * another brand holds, and only with its own key, which must be able to read that list.
 */
async function audienceClaimRefused(
  tenantId: string,
  audienceId: string,
  existing: MailchimpTenantConfig | undefined,
  input: { apiKey?: string; serverPrefix?: string },
): Promise<NextResponse | null> {
  if (audienceId === process.env.MAILCHIMP_AUDIENCE_ID?.trim()) return fail("audience_reserved", 409);
  const holders = await getTenantsByMailchimpAudience(audienceId);
  // Never say which brand holds it.
  if (holders.some((t) => t.id !== tenantId)) return fail("audience_in_use", 409);

  // The key that goes with it: the one in this request, else the one already saved.
  // Without its own key a brand never sends to that audience, so the id would only
  // route someone else's webhook events here.
  let apiKey: string | null;
  if (input.apiKey !== undefined) {
    apiKey = input.apiKey.trim() || null;
  } else {
    const own = readOwnMailchimpKey(tenantId, existing);
    apiKey = own.ok ? own.apiKey : null;
  }
  if (!apiKey) return fail("own_key_required", 400);

  const serverPrefix =
    input.serverPrefix?.trim() || existing?.serverPrefix?.trim() || deriveServerPrefix(apiKey);
  // A key with no data centre can't read any list.
  if (!serverPrefix) return fail("audience_not_yours", 400);
  // The key goes to this host, so only a Mailchimp data centre (a saved prefix from
  // before this check, or a key whose suffix isn't one, is refused here too).
  if (!isMailchimpServerPrefix(serverPrefix)) return fail("invalid_server_prefix", 400);
  const read = await getAudience({ apiKey, serverPrefix, audienceId });
  if (read.ok) return null;
  if (read.reason === "timeout" || read.reason === "request_error" || (read.status ?? 0) >= 500) {
    return fail("mailchimp_unreachable", 502);
  }
  return fail("audience_not_yours", 400);
}

/**
 * Update the BYO feature gate + (optionally) the tenant's own credentials. Admins only.
 * `requiresOwnApiKey` can be turned on here but never off (the owner does that). A changed
 * audience id must pass audienceClaimRefused; an unchanged one is not checked again, so an
 * existing configuration can be saved as it is. A server prefix must be a Mailchimp data
 * centre (us21), because the key is sent to that host. Nothing is saved on any refusal.
 */
export async function PUT(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return fail("unauthorized", 401);
  if (ctx.role !== "admin") return fail("forbidden", 403);

  const parsed = SettingsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_input", 400);
  }

  const tenant = await getTenantById(ctx.tenantId);
  if (!tenant) {
    return fail("tenant_not_found", 404);
  }
  const existing = tenant.mailchimpConfig;

  if (existing?.requiresOwnApiKey === true && parsed.data.requiresOwnApiKey === false) {
    return fail("requires_own_key_locked", 403);
  }

  // Only a Mailchimp data centre such as us21, or empty to use the key's own.
  const serverPrefix = parsed.data.serverPrefix?.trim();
  if (serverPrefix && !isMailchimpServerPrefix(serverPrefix)) {
    return fail("invalid_server_prefix", 400);
  }

  const audienceId = parsed.data.audienceId?.trim();
  // Unchanged when it matches the saved id once both are trimmed. Then the saved id is
  // kept exactly as stored: a padded id saved before these checks never matches the
  // webhook's list_id, and saving it trimmed would claim that audience unchecked.
  const unchanged = Boolean(audienceId) && audienceId === (existing?.audienceId?.trim() ?? "");
  if (audienceId && !unchanged) {
    const refused = await audienceClaimRefused(ctx.tenantId, audienceId, existing, parsed.data);
    if (refused) return refused;
  }

  // Sealed when the switch is on (a kept plain key is sealed too). The whole map
  // is replaced below, so a plain `apiKey` left out here is gone from the record.
  let keyFields: ReturnType<typeof storedKeyFields>;
  try {
    keyFields = storedKeyFields(
      ctx.tenantId,
      existing,
      parsed.data.apiKey,
      isMailchimpKeySealingEnabled(),
    );
  } catch (err) {
    if ((err as Error).message !== MAILCHIMP_KEY_UNCONFIGURED) throw err;
    return fail("mailchimp_key_sealing_unconfigured", 503);
  }

  const next = {
    requiresOwnApiKey: parsed.data.requiresOwnApiKey,
    ...keyFields,
    audienceId: audienceId === undefined || unchanged ? existing?.audienceId : audienceId,
    serverPrefix: serverPrefix ?? existing?.serverPrefix,
  };

  await updateTenantConfig(ctx.tenantId, { mailchimpConfig: next });
  return NextResponse.json({ ok: true, requiresOwnApiKey: next.requiresOwnApiKey });
}
