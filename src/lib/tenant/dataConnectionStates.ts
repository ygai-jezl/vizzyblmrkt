import { TENANT_FIELD } from "./repository";
import { isAlreadyExists } from "./firestore";
import { TenantIsolationError, TenantValidationError } from "./errors";
import { regionalStoreFor } from "./ontologyEvents";
import type { FirestoreLike, TenantContext } from "./types";
import { DATA_CONNECTION_ID_RE, DATA_CONNECTION_STATE_ID_RE, ORGANISATION_CONNECTION_ID_RE, type DataConnectionState } from "@/lib/types/dataConnection";

/**
 * Sign in states for connected data (Connectors 1b, ADR-0011): the server half of a sign in with
 * Google. The browser half is a cookie holding a nonce; this record's id is the nonce's SHA-256,
 * so the record alone can't be turned back into the cookie.
 *
 * - Made when an admin presses Sign in, in the brand's regional database, valid for 10 minutes.
 * - Claimed once: the callback sets usedAt in a transaction, so a replayed callback, even one
 *   racing the first, finds it used. Then it is deleted. The X and LinkedIn flows never consume
 *   their state; this is the single use check they lack.
 * - The claim checks the brand, the admin and the connector again inside the transaction.
 * - `ttlAt` is a Date at the expiry, for the TTL policy that infra/lifecycle/setup.sh ttl turns
 *   on, so a sign in someone walked away from leaves nothing for long.
 *
 * Read by id only, so no index is needed. Nothing else reads or writes the collection.
 *
 * A sign in for an organisation (Connectors 3, ADR-0014) is made the same way, in the acting
 * brand's region (the region the organisation's connection will be kept in), and names the
 * organisation and, for a sign in again, the organisation's connection. The callback checks the
 * owner and the organisation again, live; the state only says what was started.
 */

export const DATA_CONNECTION_STATES = "data_connection_states";
/** How long a sign in may take, from pressing Sign in to coming back from Google. */
export const STATE_VALID_MS = 10 * 60_000;

const CONNECTOR_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;

/** A sign in state to make. Its expiry and time to live come from createdAt. */
export interface NewConnectionState {
  id: string;
  connectorId: string;
  uid: string;
  connectionId: string | null;
  /** For an organisation's sign in: the organisation, and the connection signed in again (or null). */
  organisationId?: string | null;
  sourceId?: string | null;
  /** Canonical ISO instant. */
  createdAt: string;
}

export type StoredConnectionState = Omit<DataConnectionState, "ttlAt">;

export type ConsumeOutcome = { ok: true; state: StoredConnectionState } | { ok: false; why: "missing" | "used" | "expired" | "mismatch" };

function invalid(field: string): never {
  throw new TenantValidationError(`bad_connection_state:${field}`);
}

/** Make the server record for a sign in. An id that exists already, in any brand, is refused. */
export async function createConnectionState(ctx: TenantContext, input: NewConnectionState, db?: FirestoreLike): Promise<StoredConnectionState> {
  if (!DATA_CONNECTION_STATE_ID_RE.test(input.id)) invalid("id");
  if (!CONNECTOR_ID_RE.test(input.connectorId)) invalid("connectorId");
  if (!input.uid || input.uid.length > 128) invalid("uid");
  if (input.connectionId !== null && !DATA_CONNECTION_ID_RE.test(input.connectionId)) invalid("connectionId");
  const organisationId = input.organisationId ?? null;
  const sourceId = input.sourceId ?? null;
  if (organisationId !== null && (!organisationId || organisationId.length > 160)) invalid("organisationId");
  if (sourceId !== null && (organisationId === null || !ORGANISATION_CONNECTION_ID_RE.test(sourceId))) invalid("sourceId");
  if (organisationId !== null && input.connectionId !== null) invalid("connectionId");
  const created = Date.parse(input.createdAt);
  if (Number.isNaN(created) || new Date(created).toISOString() !== input.createdAt) invalid("createdAt");
  const expiresAt = new Date(created + STATE_VALID_MS);
  const record: StoredConnectionState = {
    id: input.id,
    tenantId: ctx.tenantId,
    connectorId: input.connectorId,
    uid: input.uid,
    connectionId: input.connectionId,
    ...(organisationId !== null ? { organisationId, sourceId } : {}),
    createdAt: input.createdAt,
    expiresAt: expiresAt.toISOString(),
    usedAt: null,
  };
  const { id, ...rest } = record;
  const store = regionalStoreFor(ctx, db);
  try {
    await store.collection(DATA_CONNECTION_STATES).doc(id).create({ ...rest, [TENANT_FIELD]: ctx.tenantId, ttlAt: expiresAt });
  } catch (err) {
    if (isAlreadyExists(err)) throw new TenantIsolationError(`${DATA_CONNECTION_STATES}/${id} already exists; refusing to overwrite`);
    throw err;
  }
  return record;
}

/**
 * Claim a sign in state once. Inside one transaction it must be this brand's, unused, not
 * expired, and started by this admin for this connector (and for this organisation, or for none
 * when `expect.organisationId` is unset); then usedAt is set. Afterwards the record
 * is deleted, whether it was claimed now, used before or expired, so only a mismatch leaves it for
 * the admin who started it (and for the time to live). A failed delete leaves usedAt set, which
 * still refuses a replay.
 */
export async function consumeConnectionState(
  ctx: TenantContext,
  id: string,
  expect: { connectorId: string; uid: string; organisationId?: string | null },
  now: Date,
  db?: FirestoreLike,
): Promise<ConsumeOutcome> {
  if (!DATA_CONNECTION_STATE_ID_RE.test(id)) return { ok: false, why: "missing" };
  const store = regionalStoreFor(ctx, db);
  const ref = store.collection(DATA_CONNECTION_STATES).doc(id);
  const outcome = await store.runTransaction(async (txn): Promise<ConsumeOutcome> => {
    const snap = await txn.get(ref);
    const data = snap.exists ? (snap.data() ?? {}) : null;
    if (!data || data[TENANT_FIELD] !== ctx.tenantId) return { ok: false, why: "missing" };
    if (data.usedAt) return { ok: false, why: "used" };
    const expiresAt = typeof data.expiresAt === "string" ? Date.parse(data.expiresAt) : Number.NaN;
    if (!(expiresAt > now.getTime())) return { ok: false, why: "expired" };
    if (data.uid !== expect.uid || data.connectorId !== expect.connectorId) return { ok: false, why: "mismatch" };
    // A brand's sign in never finishes an organisation's, nor the other way round.
    if ((typeof data.organisationId === "string" ? data.organisationId : null) !== (expect.organisationId ?? null)) return { ok: false, why: "mismatch" };
    const usedAt = now.toISOString();
    txn.update(ref, { usedAt });
    return {
      ok: true,
      state: {
        id,
        tenantId: ctx.tenantId,
        connectorId: String(data.connectorId),
        uid: String(data.uid),
        connectionId: typeof data.connectionId === "string" ? data.connectionId : null,
        ...(typeof data.organisationId === "string"
          ? { organisationId: data.organisationId, sourceId: typeof data.sourceId === "string" && ORGANISATION_CONNECTION_ID_RE.test(data.sourceId) ? data.sourceId : null }
          : {}),
        createdAt: String(data.createdAt),
        expiresAt: String(data.expiresAt),
        usedAt,
      },
    };
  });
  if (outcome.ok || outcome.why === "used" || outcome.why === "expired") {
    try {
      await ref.delete();
    } catch {
      /* usedAt is set or it has expired: either refuses a replay, and the time to live removes it */
    }
  }
  return outcome;
}
