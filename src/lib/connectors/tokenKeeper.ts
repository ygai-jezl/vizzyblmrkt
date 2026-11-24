import { randomBytes } from "node:crypto";
import { changeDataConnection, changeOrganisationConnection, forTenant, getOrganisationConnection, type OrganisationStores, type SourceRef, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { ConnectionHealth, DataConnection, RefreshLease } from "@/lib/types/dataConnection";
import { googleClient, refreshGoogleToken, type GoogleDeps } from "./google";
import { healthAfterFailure } from "./health";
import type { ConnectorErrorCode } from "./messages";
import { openConnectorSecret, sealConnectorSecret, VaultOpenError } from "./vault";

/**
 * The token keeper for Sign in with Google (Connectors 1b, ADR-0011): a usable access token for a
 * signed in connection, refreshed when it is about to run out. Modelled on GitLab's refresh
 * (src/lib/integrations/tokenRefresh.ts), with the lease of src/lib/signals/store.ts claimSignal:
 *
 * - It refreshes 5 minutes early.
 * - Only the caller holding the refresh lease (refresh.leaseId, about 30 seconds) spends the
 *   refresh token, so two callers never refresh at once. A caller that loses the lease keeps
 *   using the current token while it still works, or waits a few seconds and reads again. A lease
 *   whose holder died runs out by itself.
 * - Every write is compare-and-set on the sealed access token it replaces, so a slower caller
 *   never overwrites a newer token, and a refresh never brings back a disconnected connection.
 * - When Google sends no new refresh token, the one kept stays.
 * - invalid_grant (Google ended the sign in) marks the connection broken with signin_refused, but
 *   only after reading it again inside the write: if another caller saved a new token meanwhile,
 *   that token is used instead.
 * - A 5xx, a 429, a timeout or the network is soft: the current token is used while it still
 *   works, and nothing is marked.
 * - A refresh token that won't open, or a missing client, never touches Google.
 *
 * Never throws for a provider or vault failure; a database error still throws.
 *
 * The keeper works over a record port (Connectors 3, ADR-0014): a brand's own connection, or an
 * organisation's connection, whose sign in serves the parts it gave its brands. Each port reads and
 * changes its own record in its own database, with its own lease and compare-and-set, and names
 * what the vault binds its secrets to (the brand, or the organisation). An organisation's lease and
 * health are written in the region its connection is kept in, whichever brand asked.
 *
 * Share access (Connectors 1c) needs no keeper: its tokens are minted for 300 seconds by
 * src/lib/connectors/shareAccess.ts shareAccessToken, held only in the server's memory and never
 * sealed or stored, so there is nothing to refresh or lease. The connector service picks the one
 * that fits each connection's method.
 */

export const ACCESS_SLOT = "access";
export const REFRESH_SLOT = "refresh";
/** Refresh when less than this is left. */
export const REFRESH_EARLY_MS = 5 * 60_000;
/** How long a caller holds the refresh lease. */
export const REFRESH_LEASE_MS = 30_000;
/** How long a caller without the lease waits for the holder's new token. */
export const LEASE_WAIT_MS = 5_000;
const LEASE_POLL_MS = 500;
/** A token this close to its expiry isn't handed out while another caller refreshes. */
const STILL_VALID_MS = 60_000;

export interface KeeperDeps extends GoogleDeps {
  db?: FirestoreLike;
  sleep?: (ms: number) => Promise<void>;
  newLeaseId?: () => string;
}

export type KeeperResult =
  | { ok: true; token: string }
  /** recorded: the keeper already wrote this failure on the connection's health. */
  | { ok: false; code: ConnectorErrorCode; retryAfterSec: number | null; recorded: boolean };

type Conn = Pick<DataConnection, "id" | "status" | "secrets" | "tokenExpiresAt" | "refresh" | "health">;

/** The fields the keeper reads and writes on a record, a brand's or an organisation's. */
export type KeeperRecord = Conn;
export interface KeeperPatch {
  secrets?: DataConnection["secrets"];
  tokenExpiresAt?: string | null;
  refresh?: RefreshLease;
  health?: ConnectionHealth;
}
/** A plan for the record: what to set, and the failure to log (Google ended the sign in). */
export type KeeperPlan = (cur: Conn) => { patch: KeeperPatch; failed?: { by: string; at: string; code: ConnectorErrorCode } } | null;
export type KeeperChange = { ok: true; record: Conn } | { ok: false; why: "not_found" } | { ok: false; why: "unchanged"; record: Conn };

/**
 * The record a sign in is kept on. `binding` is what the vault binds its secrets to: the brand's
 * id for a brand's connection, the organisation's id for an organisation's (their prefixes differ,
 * so a blob never opens as the other's).
 */
export interface KeeperPort {
  binding: string;
  id: string;
  read(): Promise<Conn | null>;
  change(plan: KeeperPlan): Promise<KeeperChange>;
}

/** A brand's own connection, in the brand's region. */
export function brandKeeperPort(ctx: TenantContext, id: string, deps: { db?: FirestoreLike } = {}): KeeperPort {
  return {
    binding: ctx.tenantId,
    id,
    read: () => forTenant(ctx, deps.db).dataConnections.getById(id),
    change: async (plan) => {
      const r = await changeDataConnection(
        ctx,
        id,
        (cur) => {
          const p = plan(cur);
          return p ? { patch: p.patch, activity: p.failed ? [{ kind: "failed", by: p.failed.by, at: p.failed.at, code: p.failed.code }] : [] } : null;
        },
        deps.db,
      );
      return r.ok ? { ok: true, record: r.connection } : r.why === "unchanged" ? { ok: false, why: "unchanged", record: r.connection } : { ok: false, why: "not_found" };
    },
  };
}

/** An organisation's connection, in the region it is kept in, with the organisation bound in. */
export function organisationKeeperPort(source: SourceRef, stores: OrganisationStores = {}): KeeperPort {
  return {
    binding: source.organisationId,
    id: source.connectionId,
    read: () => getOrganisationConnection(source.organisationId, source.connectionId, source.region, stores),
    change: async (plan) => {
      const r = await changeOrganisationConnection(
        source.organisationId,
        source.connectionId,
        source.region,
        (cur) => {
          const p = plan(cur);
          return p ? { patch: p.patch, activity: p.failed ? [{ kind: "failed", by: p.failed.by, at: p.failed.at, code: p.failed.code }] : [] } : null;
        },
        stores,
      );
      return r.ok ? { ok: true, record: r.connection } : r.why === "unchanged" ? { ok: false, why: "unchanged", record: r.connection } : { ok: false, why: "not_found" };
    },
  };
}

const ok = (token: string): KeeperResult => ({ ok: true, token });
const fail = (code: ConnectorErrorCode, retryAfterSec: number | null = null, recorded = false): KeeperResult => ({ ok: false, code, retryAfterSec, recorded });

function expiresMs(conn: Conn): number {
  const t = conn.tokenExpiresAt ? Date.parse(conn.tokenExpiresAt) : Number.NaN;
  return Number.isFinite(t) ? t : 0;
}

function accessCt(conn: Conn): string | null {
  return conn.secrets[ACCESS_SLOT]?.blob.ct ?? null;
}

/** The secret in a slot, or null when it is missing or won't open here. */
function opened(port: KeeperPort, conn: Conn, slot: string): string | null {
  const sealed = conn.secrets[slot];
  if (!sealed) return null;
  try {
    return openConnectorSecret(port.binding, port.id, slot, sealed);
  } catch (err) {
    if (err instanceof VaultOpenError) return null;
    throw err;
  }
}

/** The token another caller just saved, when it works. */
function fromStored(port: KeeperPort, cur: Conn, nowMs: number): KeeperResult {
  const token = opened(port, cur, ACCESS_SLOT);
  if (token === null) return fail("secret_unopenable");
  return expiresMs(cur) > nowMs ? ok(token) : fail("busy");
}

async function release(port: KeeperPort, leaseId: string): Promise<void> {
  await port.change((cur) => (cur.refresh?.leaseId === leaseId ? { patch: { refresh: { leaseId: null, leaseUntil: null } } } : null)).catch(() => undefined);
}

/** Wait for the lease holder's new token, reading the record again every half second. */
async function waitForHolder(port: KeeperPort, startCt: string, nowMs: number, deps: KeeperDeps): Promise<KeeperResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let waited = 0; waited < LEASE_WAIT_MS; waited += LEASE_POLL_MS) {
    await sleep(LEASE_POLL_MS);
    const cur = await port.read();
    if (!cur || cur.status !== "connected") return fail("disconnected");
    if (accessCt(cur) !== startCt) return fromStored(port, cur, nowMs);
    if (!cur.refresh?.leaseId) {
      // The holder let go without a new token: Google ended the sign in, or was down.
      if (cur.health.state === "broken" && cur.health.lastErrorCode === "signin_refused") return fail("signin_refused", null, true);
      break;
    }
  }
  return fail("busy");
}

/**
 * A usable access token for a connection signed in with Google, refreshing it first when it runs
 * out within 5 minutes. `by` names who is asking, for the activity row if the sign in has ended.
 */
export async function freshAccessToken(ctx: TenantContext, conn: Conn, by: string, deps: KeeperDeps = {}): Promise<KeeperResult> {
  return keepFresh(brandKeeperPort(ctx, conn.id, deps), conn, by, deps);
}

/**
 * The same over any record port: a brand's connection, or an organisation's (Connectors 3), whose
 * lease, compare-and-set and "Google ended the sign in" are all written on that record.
 */
export async function keepFresh(port: KeeperPort, conn: Conn, by: string, deps: KeeperDeps = {}): Promise<KeeperResult> {
  const now = deps.now ?? new Date();
  const nowMs = now.getTime();
  if (conn.status !== "connected") return fail("disconnected");
  const access = opened(port, conn, ACCESS_SLOT);
  if (access === null) return fail("secret_unopenable");
  if (expiresMs(conn) - nowMs > REFRESH_EARLY_MS) return ok(access);

  const startCt = accessCt(conn)!;
  const stillValid = expiresMs(conn) - nowMs > STILL_VALID_MS;
  const leaseId = (deps.newLeaseId ?? (() => randomBytes(12).toString("hex")))();
  const claim = await port.change((cur) => {
    if (cur.status !== "connected" || accessCt(cur) !== startCt) return null;
    const until = cur.refresh?.leaseUntil ? Date.parse(cur.refresh.leaseUntil) : 0;
    if (until > nowMs) return null;
    return { patch: { refresh: { leaseId, leaseUntil: new Date(nowMs + REFRESH_LEASE_MS).toISOString() } } };
  });
  if (!claim.ok) {
    if (claim.why === "not_found" || claim.record.status !== "connected") return fail("disconnected");
    if (accessCt(claim.record) !== startCt) return fromStored(port, claim.record, nowMs);
    // Another caller holds the lease: the current token still works, or wait for theirs.
    return stillValid ? ok(access) : waitForHolder(port, startCt, nowMs, deps);
  }

  const client = googleClient();
  if (!client) {
    await release(port, leaseId);
    return stillValid ? ok(access) : fail("signin_unconfigured");
  }
  const refreshToken = opened(port, claim.record, REFRESH_SLOT);
  if (refreshToken === null) {
    await release(port, leaseId);
    return fail("secret_unopenable");
  }

  const r = await refreshGoogleToken(refreshToken, client, deps);
  if (r.ok) {
    const sealedAccess = sealConnectorSecret(port.binding, port.id, ACCESS_SLOT, r.tokens.accessToken, now);
    const sealedRefresh = r.tokens.refreshToken ? sealConnectorSecret(port.binding, port.id, REFRESH_SLOT, r.tokens.refreshToken, now) : null;
    const saved = await port
      .change((cur) => {
        if (cur.status !== "connected" || cur.refresh?.leaseId !== leaseId || accessCt(cur) !== startCt) return null;
        const kept = cur.secrets[REFRESH_SLOT];
        return {
          patch: {
            secrets: { ...cur.secrets, [ACCESS_SLOT]: sealedAccess, ...(sealedRefresh ? { [REFRESH_SLOT]: sealedRefresh } : kept ? { [REFRESH_SLOT]: kept } : {}) },
            tokenExpiresAt: r.tokens.expiresAt,
            refresh: { leaseId: null, leaseUntil: null },
          },
        };
      })
      .catch(() => null);
    // Not saved (the database failed): the new token still works for this use; the lease runs out.
    if (!saved) return ok(r.tokens.accessToken);
    if (saved.ok) return ok(r.tokens.accessToken);
    // Disconnected meanwhile: never use or store what Google sent.
    if (saved.why === "not_found" || saved.record.status !== "connected") return fail("disconnected");
    if (accessCt(saved.record) !== startCt) return fromStored(port, saved.record, nowMs);
    // The lease ran out but nobody saved: the new token is good for this use.
    return ok(r.tokens.accessToken);
  }

  if (r.code === "signin_refused") {
    const at = now.toISOString();
    const marked = await port.change((cur) => {
      // Read again before marking: a token saved by another caller means the sign in still works.
      if (cur.status !== "connected" || accessCt(cur) !== startCt) return null;
      const next = healthAfterFailure(cur.health, "signin_refused", now);
      if (!next) return null;
      return {
        patch: { health: next.health, refresh: cur.refresh?.leaseId === leaseId ? { leaseId: null, leaseUntil: null } : cur.refresh },
        failed: { by, at, code: "signin_refused" },
      };
    });
    if (marked.ok) return fail("signin_refused", null, true);
    if (marked.why === "not_found" || marked.record.status !== "connected") return fail("disconnected");
    return fromStored(port, marked.record, nowMs);
  }

  await release(port, leaseId);
  // Soft: Google was down, slow or busy. The current token is fine while it lasts.
  return stillValid ? ok(access) : fail(r.code, r.retryAfterSec);
}
