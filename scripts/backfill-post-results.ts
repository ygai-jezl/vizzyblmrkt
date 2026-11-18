import { forTenant, listAllTenants } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { ScheduledPost } from "@/lib/types/scheduledPost";
import { backfillCandidates, enqueuePerformanceFetch } from "@/lib/distribute/scheduler";

/**
 * Get stats for posts published before the stats loop was on: queue a stats job for every
 * published X post and LinkedIn company-page post that never had one. The scheduled worker then
 * reads each post's numbers once (an old post settles on its first read) and keeps them as
 * "late", so they never skew the reward baselines.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project-id> npx tsx scripts/backfill-post-results.ts             # dry run (default)
 *   GOOGLE_CLOUD_PROJECT=<your-project-id> npx tsx scripts/backfill-post-results.ts --apply     # queue the jobs
 *   Optional: --tenant <tenantId>   --max <n> (default 200 a brand)   --spacing <seconds> (default 120)
 *
 * What each platform allows: X gives public numbers for posts of any age, and each read uses
 * the X plan's read quota. LinkedIn gives a company page's post stats for about a year, so older
 * posts are skipped; personal profile posts have no stats API. Jobs run only where
 * DISTRIBUTE_CLOSED_LOOP_ENABLED is on. Safe to run again: a post that has a job is skipped.
 */

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const APPLY = process.argv.includes("--apply");
const ONLY_TENANT = flag("tenant");
const MAX = Math.max(1, Number(flag("max") ?? 200));
const SPACING_MS = Math.max(10, Number(flag("spacing") ?? 120)) * 1000;

async function main() {
  if (!process.env.GOOGLE_CLOUD_PROJECT && !process.env.FIRESTORE_EMULATOR_HOST) {
    console.error("Set GOOGLE_CLOUD_PROJECT to the project.");
    process.exit(1);
  }
  console.log(`[post-backfill] project=${process.env.GOOGLE_CLOUD_PROJECT ?? "(emulator)"} mode=${APPLY ? "APPLY" : "dry run"}${ONLY_TENANT ? ` tenant=${ONLY_TENANT}` : ""}`);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  let failed = 0;
  for (const t of (await listAllTenants()).filter((x) => !ONLY_TENANT || x.id === ONLY_TENANT)) {
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    try {
      const repo = forTenant(ctx).scheduledPosts;
      const published = await repo.find({ where: [["status", "==", "done"], ["jobKind", "==", "publish"]], limit: 2000 });
      const jobs = new Set((await repo.find({ where: [["jobKind", "==", "performance_fetch"]], limit: 5000 })).map((j) => j.id));
      const picked = backfillCandidates(published as ScheduledPost[], (id) => jobs.has(id), nowMs).slice(0, MAX);
      const byChannel = picked.reduce<Record<string, number>>((acc, p) => ({ ...acc, [p.channel]: (acc[p.channel] ?? 0) + 1 }), {});
      console.log(`  ${t.id}: ${picked.length} post(s) to read ${JSON.stringify(byChannel)}`);
      if (!APPLY) continue;
      let i = 0;
      for (const p of picked) {
        const ref = p.publishedRef!;
        await enqueuePerformanceFetch(repo, p, ref.remoteId!, p.body, now, ref.authorUrn ?? p.linkedInAuthorUrn ?? null, {
          publishedAt: ref.publishedAt,
          scheduledAt: new Date(nowMs + i * SPACING_MS).toISOString(),
        });
        i += 1;
      }
    } catch (err) {
      failed += 1;
      console.error(`  ${t.id}: failed: ${err instanceof Error ? err.message.slice(0, 300) : "error"}`);
    }
  }
  console.log(APPLY ? `[post-backfill] queued${failed ? `, ${failed} brand(s) failed` : ""}` : "[post-backfill] dry run: nothing queued. Add --apply.");
  process.exit(failed ? 1 : 0);
}

void main();
