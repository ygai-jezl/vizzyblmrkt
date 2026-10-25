import { getDb, isAlreadyExists } from "./firestore";
import type { FirestoreLike } from "./types";
import { TenantIsolationError } from "./errors";
import type { Region } from "@/lib/types/tenant";

/**
 * Control-plane routing for launch site keys (LAUNCH_SITE_SIGNUPS_ENABLED). A call
 * to POST /api/v2/signups carries only a key id and has no tenant context yet, so
 * `launch_keys/{keyId}` maps it to its tenant, region and launch: the same pattern
 * as `connection_keys` (./connectionKeys.ts), in its own collection so a site key
 * never routes as a product key or the other way round. It holds NO PII and no
 * secret: the call is only trusted once its secret matches the sealed one in the
 * launch's site key, in the tenant's regional database.
 *
 * Write order: the regional site key first, then this lookup; on revoke, delete
 * this lookup FIRST so the key stops routing (bounded by the resolver's cache).
 */

const COLLECTION = "launch_keys";

export interface LaunchKeyRecord {
  keyId: string;
  tenantId: string;
  region: Region;
  campaignId: string;
  createdAt: string;
}

function defaultDb(): FirestoreLike {
  return getDb() as unknown as FirestoreLike;
}

/** Register a new key id. Atomic create: a key id is never re-pointed. */
export async function putLaunchKey(rec: LaunchKeyRecord, db: FirestoreLike = defaultDb()): Promise<void> {
  try {
    await db.collection(COLLECTION).doc(rec.keyId).create({ ...rec });
  } catch (err) {
    if (isAlreadyExists(err)) {
      throw new TenantIsolationError(`${COLLECTION}/${rec.keyId} already exists`);
    }
    throw err;
  }
}

export async function getLaunchKey(keyId: string, db: FirestoreLike = defaultDb()): Promise<LaunchKeyRecord | null> {
  if (!keyId) return null;
  const snap = await db.collection(COLLECTION).doc(keyId).get();
  if (!snap.exists) return null;
  const d = snap.data() ?? {};
  if (typeof d.tenantId !== "string" || typeof d.region !== "string" || typeof d.campaignId !== "string") {
    return null;
  }
  return {
    keyId,
    tenantId: d.tenantId,
    region: d.region as Region,
    campaignId: d.campaignId,
    createdAt: typeof d.createdAt === "string" ? d.createdAt : "",
  };
}

/** Remove a key's routing. Only the owning tenant may delete it. */
export async function deleteLaunchKey(keyId: string, tenantId: string, db: FirestoreLike = defaultDb()): Promise<void> {
  const ref = db.collection(COLLECTION).doc(keyId);
  const snap = await ref.get();
  if (!snap.exists) return;
  if ((snap.data() ?? {}).tenantId !== tenantId) {
    throw new TenantIsolationError(`${COLLECTION}/${keyId} belongs to another tenant`);
  }
  await ref.delete();
}
