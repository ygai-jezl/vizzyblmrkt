/**
 * connectors-purge.ts: remove what YouGrow keeps for a brand's connected data
 * (src/lib/connectors/purge.ts, ADR-0011). Works with every connector switch off.
 *
 * For one connection (--connection) or every connection of the brand, it deletes the sealed
 * secrets, the recent list and the activity rows, marks each connection disconnected and leaves
 * one "purged" activity row as the trace. It never calls a provider: delete a pasted token at the
 * provider too.
 *
 * DRY RUN by default: it prints ids and counts, never a secret. Pass --apply --by <label> to write.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/connectors-purge.ts --tenant <tenantId>
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/connectors-purge.ts --tenant <tenantId> --apply --by <label>
 * Optional:  --connection <dcn_id>   --local (the emulators only)
 *
 * Auth = Application Default Credentials (`gcloud auth application-default login`). --by takes a
 * short label (lower case letters, digits, _ and -), recorded as purge:<label>, never an email.
 */

import { parseOperatorArgs, printHeader, refuse, settleEnvironment } from "./lib/operatorCli";

const TOOL = "connectors-purge";
const args = parseOperatorArgs(TOOL, process.argv.slice(2), ["tenant", "connection", "by"], ["apply", "local"]);
const APPLY = args.has("apply");

async function main() {
  const tenantId = args.get("tenant");
  if (!tenantId) refuse(TOOL, "Pass --tenant <tenantId>: the purge works on one brand at a time.");
  const where = settleEnvironment(TOOL, args.has("local"));
  // Imported after the environment is settled, so the library reads it.
  const { getTenantById } = await import("@/lib/tenant");
  const { purgeActor, purgeConnections, purgeLines } = await import("@/lib/connectors/purge");

  printHeader(TOOL, where, [`mode=${APPLY ? "APPLY" : "dry run"}`, `brand ${tenantId}${args.get("connection") ? `, connection ${args.get("connection")}` : ", every connection"}`]);
  if (APPLY) {
    try {
      purgeActor(args.get("by"));
    } catch (err) {
      refuse(TOOL, `${(err as Error).message}. --apply needs --by <label>.`);
    }
  }
  const tenant = await getTenantById(tenantId);
  if (!tenant) refuse(TOOL, `No brand ${tenantId}.`);

  const report = await purgeConnections({ tenantId: tenant.id, region: tenant.region, source: "system" }, { connectionId: args.get("connection"), apply: APPLY, by: args.get("by") });
  for (const line of purgeLines(report)) console.log(`[${TOOL}] ${line}`);
  if (!report.items.length) console.log(`[${TOOL}] Nothing to purge.`);
  else if (!APPLY) console.log(`[${TOOL}] Dry run: nothing was changed. Run again with --apply --by <label> to purge.`);
  if (report.missing) process.exit(1);
}

main().catch((err) => {
  console.error(`[${TOOL}] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
