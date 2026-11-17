import { listAllTenants } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { tenantMayUse } from "@/lib/plans/brandAccess";
import { sweepBrand } from "@/lib/search/sweep";

/**
 * Fill each brand's search index from what it already has (brand search, addon:search). The
 * scheduled check does the same a little at a time; this does it all at once, brand by brand.
 * Only brands that may use search (GRANTED_ONLY_FEATURES / grantedFeatures) are touched.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project-id> npx tsx scripts/search-backfill.ts            # dry run (default)
 *   GOOGLE_CLOUD_PROJECT=<your-project-id> npx tsx scripts/search-backfill.ts --apply    # embed and write
 *   Optional: --tenant <tenantId>
 *
 * The dry run reads every brand's records and the index and prints, per brand, how many records
 * there are by kind, how many would be indexed and how many removed. Nothing is embedded or
 * written. --apply embeds what changed (gemini-embedding-001 in the brand's region, about
 * $0.15 per million tokens) and writes it. Safe to run again: unchanged records are skipped.
 * Needs ADC (`gcloud auth application-default login`) that can read the project's databases,
 * the search databases (search, search-eu, search-asia) and call Vertex AI.
 */

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const APPLY = process.argv.includes("--apply");
const ONLY_TENANT = flag("tenant");

async function main() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project && !process.env.FIRESTORE_EMULATOR_HOST) {
    console.error("Set GOOGLE_CLOUD_PROJECT to the project to fill.");
    process.exit(1);
  }
  // The indexer does nothing while its switch is off; this script is the operator turning it on.
  process.env.SEARCH_INDEX_ENABLED = "true";
  console.log(`[search-backfill] project=${project ?? "(emulator)"} mode=${APPLY ? "APPLY" : "dry run"}${ONLY_TENANT ? ` tenant=${ONLY_TENANT}` : ""}`);

  const tenants = (await listAllTenants()).filter((t) => (!ONLY_TENANT || t.id === ONLY_TENANT) && tenantMayUse(t, "brand_search"));
  if (!tenants.length) console.log("No brand to fill (check --tenant, and GRANTED_ONLY_FEATURES with the brand's grantedFeatures).");
  let failed = 0;
  for (const t of tenants) {
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    try {
      const c = await sweepBrand(ctx, { dryRun: !APPLY });
      const kinds = Object.entries(c.byKind)
        .map(([k, n]) => `${k} ${n}`)
        .join(", ");
      console.log(
        `  ${t.id} (${t.region}): ${c.records} records [${kinds || "none"}]; ` +
          (APPLY ? `indexed ${c.indexed}, unchanged ${c.unchanged}, removed ${c.removed}, failed ${c.failed}` : `would index ${c.changed}, would remove ${c.removed}`),
      );
      failed += c.failed;
    } catch (err) {
      failed += 1;
      console.error(`  ${t.id}: failed: ${err instanceof Error ? err.message.slice(0, 300) : "error"}`);
    }
  }
  console.log(APPLY ? `[search-backfill] done${failed ? `, ${failed} failed (run it again to retry)` : ""}` : "[search-backfill] dry run: nothing written. Add --apply to fill.");
  process.exit(failed ? 1 : 0);
}

void main();
