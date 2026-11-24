/**
 * connectors-purge.ts: remove what YouGrow keeps for a brand's connected data
 * (src/lib/connectors/purge.ts, ADR-0011). Works with every connector switch off.
 *
 * For one connection (--connection) or every connection of the brand, it deletes the sealed
 * secrets, the recent list, the activity rows and everything it collected (its metric snapshots,
 * ADR-0012, and a Search Console connection's searches in brand search, ADR-0013, even with
 * indexing off), marks each connection disconnected and leaves one "purged" activity row as the trace. Delete a pasted token at the provider too. It calls a
 * provider only to revoke a Google sign in, and only with CONNECTOR_GOOGLE_REVOKE_ENABLED on and
 * CONNECTORS_VAULT_KEY set: Google's revoke ends every grant of that Google account, for every brand.
 *
 * Share access: with CONNECTORS_IDENTITIES_PROJECT set, it deletes each purged connection's Google
 * address in that project, and lists the brand's leftover addresses (ones no live connection owns)
 * and deletes them too. --addresses does only that, plus the disconnected connections whose address
 * a failed delete left behind, and leaves every record and its history alone. Your Application
 * Default Credentials need to list and delete service accounts in the identities project.
 *
 * Shared connections (Connectors 3, ADR-0014): a brand's purge also ends its parts on their
 * organisation's record, wherever that is kept. --organisation <orgId> (or --organisation all)
 * purges organisations' own connections instead, in every provisioned region, whatever any switch
 * says: each is disconnected (every brand's part ended and erased in its own region, its Google
 * address deleted, a sign in revoked only with CONNECTOR_GOOGLE_REVOKE_ENABLED), its activity and
 * secrets removed, and the organisation's leftover Google addresses deleted. Run it before reverting
 * to a build from before Connectors 3: older builds can't remove an organisation's sign ins.
 *
 * DRY RUN by default: it prints ids and counts, never a secret. Pass --apply --by <label> to write.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/connectors-purge.ts --tenant <tenantId>
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/connectors-purge.ts --tenant <tenantId> --apply --by <label>
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/connectors-purge.ts --organisation <orgId|all>
 * Optional:  --connection <dcn_id>   --addresses (leftover Google addresses only)   --local (the emulators only)
 *
 * Auth = Application Default Credentials (`gcloud auth application-default login`). --by takes a
 * short label (lower case letters, digits, _ and -), recorded as purge:<label>, never an email.
 */

import { parseOperatorArgs, printHeader, refuse, settleEnvironment } from "./lib/operatorCli";

const TOOL = "connectors-purge";
const args = parseOperatorArgs(TOOL, process.argv.slice(2), ["tenant", "connection", "by", "organisation"], ["apply", "local", "addresses"]);
const APPLY = args.has("apply");
const ADDRESSES = args.has("addresses");

async function purgeOrganisation(target: string) {
  if (args.get("tenant") || args.get("connection") || ADDRESSES) refuse(TOOL, "--organisation goes alone: it purges organisations' own connections in every region.");
  if (target !== "all" && !target.startsWith("org_")) refuse(TOOL, "--organisation takes an organisation id (org_...) or all.");
  const where = settleEnvironment(TOOL, args.has("local"));
  if (args.has("local")) delete process.env.CONNECTORS_IDENTITIES_PROJECT;
  const { purgeActor, purgeOrganisations, organisationPurgeLines } = await import("@/lib/connectors/purge");
  printHeader(TOOL, where, [`mode=${APPLY ? "APPLY" : "dry run"}`, `${target === "all" ? "every organisation" : `organisation ${target}`}, every region, whatever any switch says`]);
  if (APPLY) {
    try {
      purgeActor(args.get("by"));
    } catch (err) {
      refuse(TOOL, `${(err as Error).message}. --apply needs --by <label>.`);
    }
  }
  const report = await purgeOrganisations(target, { apply: APPLY, by: args.get("by") });
  for (const line of organisationPurgeLines(report)) console.log(`[${TOOL}] ${line}`);
  const left = report.items.filter((i) => i.status === "connected" || i.secrets > 0 || i.address === "kept" || i.parts > 0).length + report.orphans.length;
  if (!APPLY) console.log(`[${TOOL}] Dry run: nothing was changed. ${left ? `${left} still to purge: run again with --apply --by <label>.` : "Nothing is left: no organisation connection holds a sign in, a secret, a part or a Google address."}`);
  else console.log(`[${TOOL}] Run the dry run again: it should say nothing is left.`);
}

async function main() {
  const organisation = args.get("organisation");
  if (organisation) return purgeOrganisation(organisation);
  const tenantId = args.get("tenant");
  if (!tenantId) refuse(TOOL, "Pass --tenant <tenantId>: the purge works on one brand at a time (or --organisation <orgId|all> for organisations' own connections).");
  const where = settleEnvironment(TOOL, args.has("local"));
  // The emulators never reach a real identities project.
  if (args.has("local")) delete process.env.CONNECTORS_IDENTITIES_PROJECT;
  // Imported after the environment is settled, so the library reads it.
  const { getTenantById } = await import("@/lib/tenant");
  const { purgeActor, purgeConnections, purgeLines } = await import("@/lib/connectors/purge");

  printHeader(TOOL, where, [
    `mode=${APPLY ? "APPLY" : "dry run"}${ADDRESSES ? ", leftover Google addresses only" : ""}`,
    `brand ${tenantId}${args.get("connection") ? `, connection ${args.get("connection")}` : ", every connection"}`,
  ]);
  if (APPLY) {
    try {
      purgeActor(args.get("by"));
    } catch (err) {
      refuse(TOOL, `${(err as Error).message}. --apply needs --by <label>.`);
    }
  }
  const tenant = await getTenantById(tenantId);
  if (!tenant) refuse(TOOL, `No brand ${tenantId}.`);

  const report = await purgeConnections(
    { tenantId: tenant.id, region: tenant.region, source: "system" },
    { connectionId: args.get("connection"), apply: APPLY, by: args.get("by"), addressesOnly: ADDRESSES },
  );
  for (const line of purgeLines(report)) console.log(`[${TOOL}] ${line}`);
  if (!report.items.length && !report.orphans.length) console.log(`[${TOOL}] Nothing to purge.`);
  else if (!APPLY) console.log(`[${TOOL}] Dry run: nothing was changed. Run again with --apply --by <label> to purge.`);
  if (report.missing) process.exit(1);
}

main().catch((err) => {
  console.error(`[${TOOL}] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
