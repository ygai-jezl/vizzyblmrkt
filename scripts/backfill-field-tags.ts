/**
 * backfill-field-tags.ts: rebuild the People list's field tags (`field:<fieldId>:<optionId>` and
 * `field:<fieldId>:yes`) from the field values people already have (AUDIENCE_FIELDS_ENABLED).
 * The field writer keeps them in step from now on; this covers values written without their
 * tags (before the writer kept them, or after a revert), so the field filters find everyone.
 * Every other tag is kept as it is.
 *
 * DRY RUN by default: it says how many people it would update and leave alone. Pass --apply to
 * write. Safe to re-run: a person whose tags are already right is left alone. It prints counts
 * only, never an address or a value.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/backfill-field-tags.ts
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/backfill-field-tags.ts --apply
 * Optional:  --tenant <tenantId>
 *
 * Auth = Application Default Credentials (`gcloud auth application-default login`).
 * Pages contacts by (tenantId, createdAt DESC), an existing index.
 */

// Never touch a local emulator (a dev shell may export these).
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

import { forTenant, listAllTenants, repairFieldTags } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { Contact } from "@/lib/types/contact";
import { isFieldTag } from "@/lib/audience/fieldTags";

const PAGE = 300;
const APPLY = process.argv.includes("--apply");

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const ONLY_TENANT = flag("tenant");

/** Whether a person could need their tags rebuilt: they have values, or field tags. */
function mayNeedRepair(c: Pick<Contact, "fields" | "memberOf">): boolean {
  return Object.keys(c.fields ?? {}).length > 0 || (c.memberOf ?? []).some(isFieldTag);
}

async function main() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    console.error("Set GOOGLE_CLOUD_PROJECT to the project whose Firestore to backfill.");
    process.exit(1);
  }
  console.log(`[field-tags] project=${project} mode=${APPLY ? "APPLY" : "dry-run"}${ONLY_TENANT ? ` tenant=${ONLY_TENANT}` : ""}`);

  const tenants = (await listAllTenants()).filter((t) => !ONLY_TENANT || t.id === ONLY_TENANT);
  const counts = { scanned: 0, updated: 0, unchanged: 0, missing: 0, failed: 0 };
  for (const t of tenants) {
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    const repo = forTenant(ctx);
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (;;) {
      const page: Contact[] = await repo.contacts.find({ orderBy: [["createdAt", "desc"]], limit: PAGE, ...(cursor ? { startAfter: [cursor] } : {}) });
      for (const c of page) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        counts.scanned += 1;
        if (!mayNeedRepair(c)) {
          counts.unchanged += 1;
          continue;
        }
        try {
          counts[await repairFieldTags(ctx, c.id, { dryRun: !APPLY })] += 1;
        } catch (err) {
          counts.failed += 1;
          console.warn(`[field-tags] ${t.id}: a repair failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
        }
      }
      if (page.length < PAGE) break;
      // People who share the last time are read again on the next page, and skipped by id.
      cursor = page[page.length - 1]!.createdAt;
      const next = page.filter((c) => c.createdAt !== cursor);
      if (next.length === 0) {
        console.warn(`[field-tags] ${t.id}: ${PAGE}+ contacts share one createdAt; some may be skipped`);
      } else {
        cursor = next[next.length - 1]!.createdAt;
      }
    }
  }
  console.log(`[field-tags] ${APPLY ? "done" : "would"}: ${JSON.stringify(counts)}`);
  if (!APPLY) console.log("[field-tags] dry run: nothing was written. Run again with --apply to write.");
}

main().catch((err) => {
  console.error("[field-tags] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
