/**
 * backfill-person-ids.ts: write the person (the `ct_` id of their person record) on the rows a
 * brand already has, written before ONTOLOGY_PERSON_IDS_ENABLED was on: product events, journey
 * enrolments (product and waitlist), person plans, email sends and email events. It also corrects
 * a row whose person moved while the switch was off. New rows get theirs as they are written once
 * the switch is on; this covers everything from before.
 *
 * Order per environment: AUDIENCE_PERSON_LINKS_ENABLED on (and backfill-person-links.ts run),
 * then ONTOLOGY_PERSON_IDS_ENABLED on, then a dry run, read the counts, --apply, and a dry run
 * again: stamped 0 and corrected 0 (unresolved and gone may stay). A later dry run showing
 * corrected above 0 means moves were missed: apply again.
 *
 * DRY RUN by default: it says how many rows it would stamp and correct, and how many are already
 * right, resolve to nobody now (left as they are) or are skipped (erase rows, rehearsals, a
 * sandbox's rows). Pass --apply to write. Safe to re-run: a row already right is never written.
 * It prints counts only, never an address or an id.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/backfill-person-ids.ts
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/backfill-person-ids.ts --apply
 * Optional:  --tenant <tenantId>   --store <name>   (product_events, lifecycle_enrolments,
 *            waitlist_enrolments, person_plans, email_sends, email_events)
 *
 * Auth = Application Default Credentials (`gcloud auth application-default login`). Each store is
 * read by document id within the brand, so no new index is needed. Cost: about one read per row,
 * one write per row changed, and one cached read per sign-up or product user.
 */

// Never touch a local emulator (a dev shell may export these).
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
// This script is the operator writing person ids: the switches hold for its own process only.
process.env.AUDIENCE_PERSON_LINKS_ENABLED = "true";
process.env.ONTOLOGY_PERSON_IDS_ENABLED = "true";

import { listAllTenants } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import {
  BACKFILL_STORES,
  backfillPersonIds,
  backfillStoreOf,
  emptyCounts,
  type BackfillCounts,
  type BackfillStore,
} from "@/lib/ontology/backfillPersonIds";

const APPLY = process.argv.includes("--apply");

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const ONLY_TENANT = flag("tenant");
const ONLY_STORE = flag("store");

const line = (c: BackfillCounts) =>
  `scanned=${c.scanned} ${APPLY ? "" : "would-"}stamp=${c.stamped} ${APPLY ? "" : "would-"}correct=${c.corrected} already=${c.already} unresolved=${c.unresolved} skipped=${c.skipped} gone=${c.gone} failed=${c.failed}`;

async function main() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    console.error("Set GOOGLE_CLOUD_PROJECT to the project whose Firestore to backfill.");
    process.exit(1);
  }
  let stores: BackfillStore[] | undefined;
  if (ONLY_STORE) {
    const store = backfillStoreOf(ONLY_STORE);
    if (!store) {
      console.error(`Unknown --store. Use one of: ${Object.values(BACKFILL_STORES).join(", ")}.`);
      process.exit(1);
    }
    stores = [store];
  }
  console.log(
    `[backfill-person-ids] project=${project} mode=${APPLY ? "APPLY" : "dry-run"}${ONLY_TENANT ? ` tenant=${ONLY_TENANT}` : ""}${ONLY_STORE ? ` store=${ONLY_STORE}` : ""}`,
  );

  const tenants = (await listAllTenants()).filter((t) => !ONLY_TENANT || t.id === ONLY_TENANT);
  if (!tenants.length) console.log("[backfill-person-ids] no brand to backfill (check --tenant).");
  const total = emptyCounts();
  for (const t of tenants) {
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    try {
      const byStore = await backfillPersonIds(ctx, { apply: APPLY, ...(stores ? { stores } : {}) });
      console.log(`[backfill-person-ids] ${t.id} (${t.region})`);
      for (const store of stores ?? (Object.keys(BACKFILL_STORES) as BackfillStore[])) {
        const c = byStore[store];
        console.log(`  ${BACKFILL_STORES[store]}: ${line(c)}`);
        for (const k of Object.keys(total) as Array<keyof BackfillCounts>) total[k] += c[k];
      }
    } catch (err) {
      total.failed += 1;
      console.warn(`[backfill-person-ids] ${t.id}: failed (${err instanceof Error ? err.name : "error"})`);
    }
  }
  console.log(`[backfill-person-ids] done: ${line(total)}${APPLY ? "" : " (dry run: pass --apply to write)"}`);
}

main().catch((err) => {
  // Before any row is read (credentials, the brand list): the message helps and names no one.
  console.error("[backfill-person-ids] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
