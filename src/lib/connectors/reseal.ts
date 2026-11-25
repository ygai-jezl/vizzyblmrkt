import { changeOrganisationConnection, changeDataConnection, forTenant, scanRegionOrganisationConnections, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { DataConnection } from "@/lib/types/dataConnection";
import type { Region } from "@/lib/types/tenant";
import { currentVaultKeyId, previousVaultKeyId, resealConnectorSecret, type SealedSecret } from "./vault";

/**
 * Key rotation for the connector vault (scripts/reseal-connector-secrets.ts runs it per brand).
 * API tokens such as Cloudflare's never refresh, so "reseal on the next refresh" would never
 * reach them: this moves every sealed secret onto the current root.
 *
 * - The dry run counts secrets by key id and checks each old one opens. It writes nothing.
 * - With apply, each connection is resealed in its own transaction (changeDataConnection): the
 *   freshest record is read, each secret not on the current root is opened, sealed again and the
 *   new blob opened and compared before it replaces the old one.
 * - A secret that won't open is reported by connection and slot, never replaced.
 * - The rotation is finished when a dry run counts zero secrets off the current root; only then
 *   may CONNECTORS_VAULT_KEY_PREVIOUS be removed.
 *
 * Reports name connections, slots and key ids, never a secret.
 *
 * Organisation connections (Connectors 3, ADR-0015) keep their sealed secrets in the region each was
 * connected from, bound to the organisation: resealOrganisationRegion covers one region, and the
 * script runs it for every provisioned region after the brands, so a "zero left" dry run is true for
 * them too before CONNECTORS_VAULT_KEY_PREVIOUS is removed.
 */

export interface Unopenable {
  connectionId: string;
  slot: string;
  why: string;
}

export interface BrandResealReport {
  tenantId: string;
  connections: number;
  secrets: number;
  /** Secrets by the key id that sealed them, before any reseal. */
  byKeyId: Record<string, number>;
  /** Secrets not on the current root, before any reseal. */
  offCurrent: number;
  resealed: number;
  unopenable: Unopenable[];
}

/** The slots of a connection that are not on the current root. */
function offCurrentSlots(conn: Pick<DataConnection, "secrets">, current: string | null): Array<[string, SealedSecret]> {
  return Object.entries(conn.secrets).filter(([, s]) => s.encKeyId !== current);
}

/** Count, check and (with apply) reseal one brand's connection secrets. */
export async function resealBrand(ctx: TenantContext, opts: { apply: boolean; db?: FirestoreLike; now?: Date }): Promise<BrandResealReport> {
  const current = currentVaultKeyId();
  if (opts.apply && !current) throw new Error("connectors_vault_key_unconfigured");
  const now = opts.now ?? new Date();
  const conns = await forTenant(ctx, opts.db).dataConnections.find();
  const report: BrandResealReport = { tenantId: ctx.tenantId, connections: conns.length, secrets: 0, byKeyId: {}, offCurrent: 0, resealed: 0, unopenable: [] };

  for (const conn of conns) {
    for (const s of Object.values(conn.secrets)) {
      report.secrets += 1;
      report.byKeyId[s.encKeyId] = (report.byKeyId[s.encKeyId] ?? 0) + 1;
    }
    const off = offCurrentSlots(conn, current);
    report.offCurrent += off.length;
    if (!off.length) continue;

    if (!opts.apply) {
      for (const [slot, sealed] of off) {
        const r = resealConnectorSecret(ctx.tenantId, conn.id, slot, sealed, now);
        if (!r.ok) report.unopenable.push({ connectionId: conn.id, slot, why: r.why });
      }
      continue;
    }

    // The plan can run again on contention, so its findings are kept from its last run only.
    let found: { resealed: number; unopenable: Unopenable[] } = { resealed: 0, unopenable: [] };
    await changeDataConnection(
      ctx,
      conn.id,
      (fresh) => {
        found = { resealed: 0, unopenable: [] };
        const secrets = { ...fresh.secrets };
        for (const [slot, sealed] of offCurrentSlots(fresh, current)) {
          const r = resealConnectorSecret(ctx.tenantId, fresh.id, slot, sealed, now);
          if (!r.ok) found.unopenable.push({ connectionId: fresh.id, slot, why: r.why });
          else if (r.changed) {
            secrets[slot] = r.sealed;
            found.resealed += 1;
          }
        }
        return found.resealed ? { patch: { secrets }, activity: [] } : null;
      },
      opts.db,
    );
    report.resealed += found.resealed;
    report.unopenable.push(...found.unopenable);
  }
  return report;
}

/**
 * Count, check and (with apply) reseal the sealed secrets of every organisation connection kept in
 * one region, each bound to its organisation. `tenantId` on the report names the region
 * (`organisations:<region>`), for the script's lines.
 */
export async function resealOrganisationRegion(region: Region, opts: { apply: boolean; db?: FirestoreLike; now?: Date }): Promise<BrandResealReport> {
  const current = currentVaultKeyId();
  if (opts.apply && !current) throw new Error("connectors_vault_key_unconfigured");
  const now = opts.now ?? new Date();
  const stores = opts.db ? { regionDb: () => opts.db! } : {};
  const { records: conns, unreadable } = await scanRegionOrganisationConnections(region, {}, stores);
  const report: BrandResealReport = { tenantId: `organisations:${region}`, connections: conns.length + unreadable.length, secrets: 0, byKeyId: {}, offCurrent: 0, resealed: 0, unopenable: [] };
  // A record that doesn't parse can't be resealed, and may hold secrets on the old key: never "zero left" while one is there.
  for (const id of unreadable) report.unopenable.push({ connectionId: id, slot: "record", why: "does_not_parse" });
  for (const conn of conns) {
    for (const s of Object.values(conn.secrets)) {
      report.secrets += 1;
      report.byKeyId[s.encKeyId] = (report.byKeyId[s.encKeyId] ?? 0) + 1;
    }
    const off = offCurrentSlots(conn, current);
    report.offCurrent += off.length;
    if (!off.length) continue;
    if (!opts.apply) {
      for (const [slot, sealed] of off) {
        const r = resealConnectorSecret(conn.organisationId, conn.id, slot, sealed, now);
        if (!r.ok) report.unopenable.push({ connectionId: conn.id, slot, why: r.why });
      }
      continue;
    }
    let found: { resealed: number; unopenable: Unopenable[] } = { resealed: 0, unopenable: [] };
    await changeOrganisationConnection(
      conn.organisationId,
      conn.id,
      region,
      (fresh) => {
        found = { resealed: 0, unopenable: [] };
        const secrets = { ...fresh.secrets };
        for (const [slot, sealed] of offCurrentSlots(fresh, current)) {
          const r = resealConnectorSecret(fresh.organisationId, fresh.id, slot, sealed, now);
          if (!r.ok) found.unopenable.push({ connectionId: fresh.id, slot, why: r.why });
          else if (r.changed) {
            secrets[slot] = r.sealed;
            found.resealed += 1;
          }
        }
        return found.resealed ? { patch: { secrets }, activity: [] } : null;
      },
      stores,
    );
    report.resealed += found.resealed;
    report.unopenable.push(...found.unopenable);
  }
  return report;
}

/** The lines the script prints for one brand: counts and key ids, never a secret. */
export function reportLines(r: BrandResealReport, apply: boolean): string[] {
  const current = currentVaultKeyId();
  const previous = previousVaultKeyId();
  const name = (id: string) => (id === current ? `${id} (current)` : id === previous ? `${id} (previous)` : `${id} (no key set for it)`);
  const keys = Object.entries(r.byKeyId)
    .map(([id, n]) => `${n} on ${name(id)}`)
    .join(", ");
  const lines = [`${r.tenantId}: ${r.connections} connections, ${r.secrets} secrets${keys ? `: ${keys}` : ""}`];
  if (apply) lines.push(`${r.tenantId}: resealed ${r.resealed}`);
  for (const u of r.unopenable) lines.push(`${r.tenantId}: ${u.connectionId} ${u.slot} won't open (${u.why}); left as it is`);
  return lines;
}
