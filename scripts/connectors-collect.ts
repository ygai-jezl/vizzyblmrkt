/**
 * connectors-collect.ts: catch collected numbers up after an outage (Connectors 2, ADR-0012). The
 * lane on the lifecycle tick collects each connection about every 30 minutes, a slice at a time;
 * this runs the same collect now, connection by connection, until each is up to date.
 *
 * DRY RUN by default: for every connection of the brand (or every brand), it prints where its
 * collect stands (the last day, how many days are kept, whether it is filling, held or failing, and
 * an erase still pending), never a number or a token. --apply collects, as a system job, each
 * connection that is connected, picked and not paused, up to 30 slices each, and prints the days
 * written. It respects a lease another run holds. It calls the providers, so it needs what the app
 * needs for each connection: CONNECTORS_VAULT_KEY for a pasted token, the Google sign in client for
 * a sign in, and CONNECTORS_IDENTITIES_PROJECT for share access. Any known connector is collected,
 * whatever its switch says: running this is the operator's choice.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/connectors-collect.ts --tenant <tenantId>
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/connectors-collect.ts --tenant <tenantId> --apply
 * Optional:  --connection <dcn_id>   --local (the emulators only)   no --tenant: every brand
 *
 * --close-suggestions, before reverting Connectors 2 (ADR-0012): instead of collecting, it counts
 * (dry run) or closes (--apply) every open suggestion from collected numbers, declined with its
 * values cleared, so an older build never meets an agent action it can't read. Run it for every
 * brand (no --tenant), with --apply, before the revert.
 *
 * Auth = Application Default Credentials (`gcloud auth application-default login`).
 */

import { parseOperatorArgs, printHeader, refuse, settleEnvironment } from "./lib/operatorCli";

const TOOL = "connectors-collect";
const args = parseOperatorArgs(TOOL, process.argv.slice(2), ["tenant", "connection"], ["apply", "local", "close-suggestions"]);
const APPLY = args.has("apply");
/** Slices one connection may take in one go: a 90 day backfill is at most about 18. */
const MAX_SLICES = 30;
/** Time each slice may take before no new day starts. */
const SLICE_MS = 50_000;

async function main() {
  const where = settleEnvironment(TOOL, args.has("local"));
  if (args.has("local")) delete process.env.CONNECTORS_IDENTITIES_PROJECT;
  // Imported after the environment is settled, so the library reads it.
  const { forTenant, getTenantById, listAllTenants } = await import("@/lib/tenant");
  const { collectConnection, collectOf } = await import("@/lib/connectors/collect/run");
  const { keptDays } = await import("@/lib/connectors/collect/schedule");
  const { knownConnector } = await import("@/lib/connectors/registry");
  const { collectedStream } = await import("@/lib/connectors/manifest");

  const only = args.get("tenant");
  const connectionId = args.get("connection");
  if (connectionId && !only) refuse(TOOL, "--connection needs --tenant.");
  printHeader(TOOL, where, [`mode=${APPLY ? "APPLY" : "dry run"}`, only ? `brand ${only}${connectionId ? `, connection ${connectionId}` : ""}` : "every brand"]);

  const tenants = only ? [await getTenantById(only)].filter((t): t is NonNullable<typeof t> => t !== null) : await listAllTenants();
  if (only && !tenants.length) refuse(TOOL, `No brand ${only}.`);
  if (args.has("close-suggestions")) {
    const { closeAllSuggestions } = await import("@/lib/connectors/signals/reconcile");
    let open = 0;
    for (const t of tenants) {
      const r = await closeAllSuggestions({ tenantId: t.id, region: t.region, source: "system" }, { apply: APPLY });
      open += r.open;
      if (r.open) console.log(`[${TOOL}] ${t.id}: ${r.open} open suggestions from collected numbers${APPLY ? `, ${r.closed} closed, ${r.withdrawn} proposed questions withdrawn` : ""}`);
    }
    console.log(`[${TOOL}] ${open} open suggestions in all.${APPLY ? "" : " Dry run: nothing was closed. Run again with --apply to close them."}`);
    process.exit(0);
  }
  let failed = 0;
  let listed = 0;
  for (const t of tenants) {
    const ctx = { tenantId: t.id, region: t.region, source: "system" as const };
    const all = await forTenant(ctx).dataConnections.find({ limit: 200 });
    const conns = all.filter((c) => (!connectionId || c.id === connectionId) && collectedStream(knownConnector(c.connectorId) ?? { produces: [] }));
    for (const c of conns) {
      listed += 1;
      const s = collectOf(c);
      const keep = collectedStream(knownConnector(c.connectorId)!)!.collect.keepDays;
      const state = [
        `${c.status}`,
        s.lastDay ? `to ${s.lastDay}, ${keptDays(s, keep)} of ${keep} days` : "nothing collected yet",
        s.filled ? "" : "filling",
        s.holdReason ? `held (${s.holdReason})` : "",
        s.failedSince ? `failing since ${s.failedSince.slice(0, 10)}` : "",
        s.erasePending ? "erase pending" : "",
        c.pausedAt ? "paused" : "",
        c.account ? "" : "no property chosen",
      ].filter(Boolean);
      console.log(`[${TOOL}] ${t.id}: ${c.id} (${c.connectorId}): ${state.join(", ")}`);
      if (!APPLY || c.status !== "connected" || !c.account || c.pausedAt) continue;
      let days = 0;
      for (let slice = 0; slice < MAX_SLICES; slice++) {
        const r = await collectConnection(ctx, c.id, { deadlineMs: Date.now() + SLICE_MS, force: true }, { anyConnector: true });
        days += r.days;
        if (r.status === "failed" || r.status === "held" || r.status === "busy") {
          failed += 1;
          console.log(`[${TOOL}] ${t.id}: ${c.id}: stopped (${r.status}${r.code ? `, ${r.code}` : ""}) after ${days} days`);
          break;
        }
        const after = await forTenant(ctx).dataConnections.getById(c.id);
        if (r.status === "skipped" || !after || collectOf(after).filled) {
          console.log(`[${TOOL}] ${t.id}: ${c.id}: ${days} days written${r.status === "skipped" ? " (another run holds it, or nothing is due)" : ""}`);
          break;
        }
      }
    }
  }
  if (!listed) console.log(`[${TOOL}] No connection collects here.`);
  else if (!APPLY) console.log(`[${TOOL}] Dry run: nothing was collected. Run again with --apply to collect.`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`[${TOOL}] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
