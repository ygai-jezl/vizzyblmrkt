/**
 * reseal-connector-secrets.ts: move every connected data secret onto the current vault key, to
 * finish rotating CONNECTORS_VAULT_KEY (src/lib/connectors/reseal.ts, ADR-0011).
 *
 * Rotation, in order:
 *   1. Set the old key as CONNECTORS_VAULT_KEY_PREVIOUS and a new CONNECTORS_VAULT_KEY in the
 *      deployment, and roll it out. Old tokens still open; every new seal uses the new key.
 *   2. Run this script as a dry run: it counts secrets per brand and key id, and names any that
 *      won't open. It writes nothing and never prints a secret.
 *   3. Run it with --apply: each connection is resealed in its own transaction, and each new
 *      blob is opened and compared before it replaces the old one. A secret that won't open is
 *      reported and left as it is.
 *   4. Run the dry run again. The rotation is finished only when it counts 0 off the current
 *      key; then remove CONNECTORS_VAULT_KEY_PREVIOUS. Removing it sooner orphans every token
 *      still on it.
 *
 * Both keys come from this shell, read straight from Secret Manager:
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project> \
 *   CONNECTORS_VAULT_KEY="$(gcloud secrets versions access latest --secret=connectors-vault-key --project=<your-project>)" \
 *   CONNECTORS_VAULT_KEY_PREVIOUS="$(gcloud secrets versions access <old-version> --secret=connectors-vault-key --project=<your-project>)" \
 *     npx tsx scripts/reseal-connector-secrets.ts
 *   ...the same with --apply
 * Optional:  --tenant <tenantId>   --local (the emulators only, with the keys from .env.local)
 *
 * Organisations' own connections (Connectors 3, ADR-0014) are covered too, in every provisioned
 * region, after the brands (skipped with --tenant), so the count of secrets off the current key
 * includes them.
 *
 * Auth = Application Default Credentials (`gcloud auth application-default login`).
 */

import { count, parseOperatorArgs, printHeader, refuse, settleEnvironment } from "./lib/operatorCli";

const TOOL = "reseal-connector-secrets";
const args = parseOperatorArgs(TOOL, process.argv.slice(2), ["tenant"], ["apply", "local"]);
const APPLY = args.has("apply");
const ONLY_TENANT = args.get("tenant");

function say(line: string): void {
  console.log(`[${TOOL}] ${line}`);
}

async function main() {
  const where = settleEnvironment(TOOL, args.has("local"));
  // Imported after the environment is settled, so the library reads it.
  const { listAllTenants, getTenantById, provisionedRegions } = await import("@/lib/tenant");
  const { resealBrand, resealOrganisationRegion, reportLines } = await import("@/lib/connectors/reseal");
  const { currentVaultKeyId, previousVaultKeyId } = await import("@/lib/connectors/vault");

  const current = currentVaultKeyId();
  const previous = previousVaultKeyId();
  printHeader(TOOL, where, [
    `mode=${APPLY ? "APPLY" : "dry run"}`,
    `current key ${current ?? "not set"}, previous key ${previous ?? "not set"}`,
  ]);
  if (APPLY && !current) refuse(TOOL, "CONNECTORS_VAULT_KEY is not set in this shell. See the usage at the top of this file.");

  const tenants = ONLY_TENANT ? [await getTenantById(ONLY_TENANT)].filter((t): t is NonNullable<typeof t> => t !== null) : await listAllTenants();
  if (ONLY_TENANT && !tenants.length) refuse(TOOL, `No brand ${ONLY_TENANT}.`);

  let off = 0;
  let resealed = 0;
  let unopenable = 0;
  for (const t of tenants) {
    const r = await resealBrand({ tenantId: t.id, region: t.region, source: "system" }, { apply: APPLY });
    if (!r.connections) continue;
    for (const line of reportLines(r, APPLY)) say(line);
    off += r.offCurrent;
    resealed += r.resealed;
    unopenable += r.unopenable.length;
  }
  // Organisations' own connections, in every region (bound to the organisation, not a brand).
  if (!ONLY_TENANT) {
    for (const region of provisionedRegions()) {
      const r = await resealOrganisationRegion(region, { apply: APPLY });
      if (!r.connections) continue;
      for (const line of reportLines(r, APPLY)) say(line);
      off += r.offCurrent;
      resealed += r.resealed;
      unopenable += r.unopenable.length;
    }
  }

  say(`${count(tenants.length, "brand")}, ${count(off, "secret")} off the current key before this run${APPLY ? `, ${resealed} resealed` : ""}, ${unopenable} won't open.`);
  if (!APPLY) {
    say(
      off
        ? "Run again with --apply to reseal them."
        : unopenable
          ? `${unopenable} won't open or don't parse: look at them before CONNECTORS_VAULT_KEY_PREVIOUS is removed.`
          : "Nothing is left on an old key: the rotation is finished, and CONNECTORS_VAULT_KEY_PREVIOUS can be removed.",
    );
  } else {
    say("Run the dry run again: the rotation is finished when it counts 0 off the current key.");
  }
  if (unopenable) process.exit(1);
}

main().catch((err) => {
  console.error(`[${TOOL}] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
