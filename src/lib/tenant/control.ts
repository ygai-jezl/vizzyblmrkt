import type { z } from "zod";
import { getDb, isAlreadyExists } from "./firestore";
import { TenantIsolationError } from "./errors";
import { deriveFaviconUrl } from "./favicon";
import { TenantSchema, type Tenant } from "@/lib/types/tenant";

/**
 * Control-plane writes — the `tenants` registry lives in the (default) database,
 * NOT in a regional data-plane database. Creating a tenant is the one moment
 * `region` is chosen; it is immutable thereafter (Firestore DB locations can't
 * move), so there is deliberately no updateTenantRegion.
 *
 * The brand favicon is pulled in here at creation: when the caller doesn't
 * supply one, it is derived from `rootDomain`. Callers therefore never need to
 * know about favicons — every tenant gets one. (Accepts the schema INPUT type so
 * `faviconUrl` may be omitted; the default + derivation fill it in.)
 */
export async function createTenant(
  tenant: z.input<typeof TenantSchema>,
): Promise<Tenant> {
  const parsed = TenantSchema.parse(tenant);
  const created: Tenant = {
    ...parsed,
    faviconUrl: parsed.faviconUrl || deriveFaviconUrl(parsed.rootDomain),
  };
  const { id, ...rest } = created;
  try {
    await getDb().collection("tenants").doc(id).create(rest);
  } catch (err) {
    if (isAlreadyExists(err)) {
      throw new TenantIsolationError(`tenant ${id} already exists`);
    }
    throw err;
  }
  return created;
}

/**
 * Backfill the brand favicon on an EXISTING tenant (for docs created before the
 * field existed). Idempotent: only writes when `faviconUrl` is empty, deriving
 * it from the stored `rootDomain`. Unlike `region`, the favicon is mutable, so a
 * targeted update here is safe. Returns what it did.
 */
export async function backfillTenantFavicon(
  id: string,
): Promise<"set" | "already_set" | "not_found"> {
  const ref = getDb().collection("tenants").doc(id);
  const snap = await ref.get();
  if (!snap.exists) return "not_found";
  const data = snap.data() ?? {};
  if (typeof data.faviconUrl === "string" && data.faviconUrl.length > 0) {
    return "already_set";
  }
  const faviconUrl = deriveFaviconUrl(String(data.rootDomain ?? ""));
  if (!faviconUrl) return "already_set"; // no domain to derive from — nothing to do
  await ref.update({ faviconUrl, updatedAt: new Date().toISOString() });
  return "set";
}
