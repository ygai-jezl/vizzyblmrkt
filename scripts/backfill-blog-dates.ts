/**
 * backfill-blog-dates.ts: give blog articles that were live before true dates were kept
 * (BLOG_DATES_ENABLED) their Published date, and Updated when their page says so. Published is the
 * page's own date with --read-pages (each live page is read once), else when the article was first
 * seen live. Run it after turning the switch on.
 *
 * DRY RUN by default: it says how many articles it would date, per brand. Pass --apply to write.
 * Safe to re-run: an article that already has dates is never changed. It prints counts only.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/backfill-blog-dates.ts
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/backfill-blog-dates.ts --read-pages --apply
 * Optional:  --tenant <tenantId>
 *
 * Auth = Application Default Credentials (`gcloud auth application-default login`).
 */

// Never touch a local emulator (a dev shell may export these).
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

import { listAllTenants } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { backfillBlogDates } from "@/lib/content/blog/backfillDates";

const APPLY = process.argv.includes("--apply");
const READ_PAGES = process.argv.includes("--read-pages");

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const ONLY_TENANT = flag("tenant");

async function main() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    console.error("Set GOOGLE_CLOUD_PROJECT to the project whose Firestore to backfill.");
    process.exit(1);
  }
  console.log(`[blog-dates] project=${project} mode=${APPLY ? "APPLY" : "dry-run"}${READ_PAGES ? " read-pages" : ""}${ONLY_TENANT ? ` tenant=${ONLY_TENANT}` : ""}`);

  const tenants = (await listAllTenants()).filter((t) => !ONLY_TENANT || t.id === ONLY_TENANT);
  const total = { live: 0, dated: 0, fromPage: 0, had: 0, failed: 0 };
  for (const t of tenants) {
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    try {
      const r = await backfillBlogDates(ctx, { apply: APPLY, readPages: READ_PAGES });
      total.live += r.live;
      total.dated += r.dated;
      total.fromPage += r.fromPage;
      total.had += r.had;
      if (r.live) console.log(`[blog-dates] ${t.id} (${t.region}): ${r.live} live, ${r.dated} ${APPLY ? "" : "to be "}dated (${r.fromPage} from their page), ${r.had} already dated`);
    } catch (err) {
      total.failed += 1;
      console.warn(`[blog-dates] ${t.id}: failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    }
  }
  console.log(
    `[blog-dates] done: ${total.live} live articles, ${APPLY ? "" : "would date "}${total.dated}${APPLY ? " dated" : ""} (${total.fromPage} from their page), ${total.had} already dated, failed=${total.failed}${APPLY ? "" : " (dry run: pass --apply to write)"}`,
  );
}

main().catch((err) => {
  console.error("[blog-dates] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
