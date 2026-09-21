import { getDb, isAlreadyExists } from "./firestore";
import type { FirestoreLike } from "./types";
import { TenantIsolationError } from "./errors";
import type { Region } from "@/lib/types/tenant";

/**
 * Control-plane routing for product-connection keys. An inbound ingest request
 * carries only a public key id (X-YouGrow-Key-Id) and has no tenant context yet,
 * so `connection_keys/{keyId}` maps it to its tenant + region + connection — the
 * same pattern as `social_subscriptions`. It holds NO PII and no secret: the
 * request is only trusted once its signature verifies against the connection's
 * secret, which lives in the tenant's regional database.
 *
 * Write order (from vizzybl.ai's apiKeyService): create the regional connection
 * first, then this lookup; on revoke, delete this lookup FIRST so the key stops
 * routing immediately (bounded by the resolver's short cache).
 */

const COLLECTION = "connection_keys";

export interface ConnectionKeyRecord {
  keyId: string;
  tenantId: string;
  region: Region;
  connectionId: string;
  createdAt: string;
}

function defaultDb(): FirestoreLike {
  return getDb() as unknown as FirestoreLike;
}

/** Register a new key id. Atomic create: a key id is never re-pointed. */
export async function putConnectionKey(
  rec: ConnectionKeyRecord,
  db: FirestoreLike = defaultDb(),
): Promise<void> {
  try {
    await db.collection(COLLECTION).doc(rec.keyId).create({ ...rec });
  } catch (err) {
    if (isAlreadyExists(err)) {
      throw new TenantIsolationError(`${COLLECTION}/${rec.keyId} already exists`);
    }
    throw err;
  }
}

export async function getConnectionKey(
  keyId: string,
  db: FirestoreLike = defaultDb(),
): Promise<ConnectionKeyRecord | null> {
  if (!keyId) return null;
  const snap = await db.collection(COLLECTION).doc(keyId).get();
  if (!snap.exists) return null;
  const d = snap.data() ?? {};
  if (
    typeof d.tenantId !== "string" ||
    typeof d.region !== "string" ||
    typeof d.connectionId !== "string"
  ) {
    return null;
  }
  return {
    keyId,
    tenantId: d.tenantId,
    region: d.region as Region,
    connectionId: d.connectionId,
    createdAt: typeof d.createdAt === "string" ? d.createdAt : "",
  };
}

/** Remove a key's routing. Only the owning tenant may delete it. */
export async function deleteConnectionKey(
  keyId: string,
  tenantId: string,
  db: FirestoreLike = defaultDb(),
): Promise<void> {
  const ref = db.collection(COLLECTION).doc(keyId);
  const snap = await ref.get();
  if (!snap.exists) return;
  if ((snap.data() ?? {}).tenantId !== tenantId) {
    throw new TenantIsolationError(`${COLLECTION}/${keyId} belongs to another tenant`);
  }
  await ref.delete();
}
