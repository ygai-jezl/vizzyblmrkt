/**
 * scrub-catalog-savers.ts: catalog history used to keep who saved each version as their sign-in
 * address. It keeps a user id now (piece B, decision 30), and this replaces every address already
 * stored with that person's user id, or null when nobody signs in with it any more. Names are
 * looked up when the history is shown, and someone no longer on the team shows as "Former team
 * member". Run it once after the change reaches an environment.
 *
 * Covers every brand in every region (each brand's catalog_revisions in its regional database),
 * or one with --tenant. DRY RUN by default: it says how many addresses it would replace and
 * clear, and how many versions have none. Pass --apply to write, then run it again: replaced 0
 * and cleared 0. Safe to re-run. It prints counts only, never an address or an id.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/scrub-catalog-savers.ts
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/scrub-catalog-savers.ts --apply
 * Optional:  --tenant <tenantId>
 *
 * Auth = Application Default Credentials (`gcloud auth application-default login`), which also
 * reads Firebase Auth to look each address up, once per address. Versions are read by document
 * id within the brand, so no new index is needed.
 */

// Never touch a local emulator (a dev shell may export these).
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

import { listAllTenants } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { adminAuth } from "@/lib/auth/adminAuth";
import { cachedResolver, emptyScrubCounts, scrubCatalogSavers, type ResolveSaver, type ScrubCounts } from "@/lib/connect/catalogSavers";

const TOOL = "scrub-catalog-savers";
const APPLY = process.argv.includes("--apply");

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const ONLY_TENANT = flag("tenant");

const line = (c: ScrubCounts) =>
  `scanned=${c.scanned} ${APPLY ? "" : "would-"}replace=${c.replaced} ${APPLY ? "" : "would-"}clear=${c.cleared} no-address=${c.already} gone=${c.gone}`;

/** The user id of whoever signs in with this address, or null when nobody does. */
const lookUp: ResolveSaver = async (email) => {
  try {
    return (await adminAuth().getUserByEmail(email)).uid;
  } catch (err) {
    if ((err as { code?: string }).code === "auth/user-not-found") return null;
    throw err;
  }
};

async function main() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    console.error(`[${TOOL}] Set GOOGLE_CLOUD_PROJECT to the project whose catalog history to scrub.`);
    process.exit(1);
  }
  console.log(`[${TOOL}] project=${project} mode=${APPLY ? "APPLY" : "dry-run"}${ONLY_TENANT ? ` tenant=${ONLY_TENANT}` : ""}`);

  const tenants = (await listAllTenants()).filter((t) => !ONLY_TENANT || t.id === ONLY_TENANT);
  if (!tenants.length) console.log(`[${TOOL}] no brand to scrub (check --tenant).`);
  // One lookup per address across every brand.
  const resolve = cachedResolver(lookUp);
  const total = emptyScrubCounts();
  let failed = 0;
  for (const t of tenants) {
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    try {
      const c = await scrubCatalogSavers(ctx, { resolve, dryRun: !APPLY });
      if (c.scanned) console.log(`[${TOOL}] ${t.id} (${t.region}): ${line(c)}`);
      for (const k of Object.keys(total) as Array<keyof ScrubCounts>) total[k] += c[k];
    } catch (err) {
      failed += 1;
      console.warn(`[${TOOL}] ${t.id}: failed (${err instanceof Error ? err.name : "error"})`);
    }
  }
  console.log(`[${TOOL}] done: brands=${tenants.length} ${line(total)} failed=${failed}${APPLY ? "" : " (dry run: pass --apply to write)"}`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  // Before any version is read (credentials, the brand list): the message helps and names no one.
  console.error(`[${TOOL}] failed:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
