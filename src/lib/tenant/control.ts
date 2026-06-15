import { getDb, isAlreadyExists } from "./firestore";
import { TenantIsolationError } from "./errors";
import { TenantSchema, type Tenant } from "@/lib/types/tenant";

/**
 * Control-plane writes — the `tenants` registry lives in the (default) database,
 * NOT in a regional data-plane database. Creating a tenant is the one moment
 * `region` is chosen; it is immutable thereafter (Firestore DB locations can't
 * move), so there is deliberately no updateTenantRegion.
 */
export async function createTenant(tenant: Tenant): Promise<Tenant> {
  const parsed = TenantSchema.parse(tenant);
  const { id, ...rest } = parsed;
  try {
    await getDb().collection("tenants").doc(id).create(rest);
  } catch (err) {
    if (isAlreadyExists(err)) {
      throw new TenantIsolationError(`tenant ${id} already exists`);
    }
    throw err;
  }
  return parsed;
}
