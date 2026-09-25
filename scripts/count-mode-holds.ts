/**
 * count-mode-holds.ts — before LIFECYCLE_GO_LIVE_SWEEP goes on: how many
 * product-journey enrolments are held for their delivery mode (e.g. a live journey
 * under a `test` ceiling, for someone who isn't a test recipient) without having
 * sent anything, and how many of those are already past their trigger's window —
 * the ones that will exit with `window_passed` instead of starting late.
 * Read-only; prints counts only, never a person.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/count-mode-holds.ts
 * Optional:  --tenant <tenantId>
 *
 * Auth = Application Default Credentials (`gcloud auth application-default login`).
 */

// Never touch a local emulator (a dev shell may export these).
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

import { forTenant, listAllTenants } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { versionDocId } from "@/lib/lifecycle/enrol";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const ONLY_TENANT = flag("tenant");

async function main() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    console.error("Set GOOGLE_CLOUD_PROJECT to the project to check.");
    process.exit(1);
  }
  console.log(`[mode-holds] project=${project} (read-only)`);
  const nowMs = Date.now();
  let held = 0;
  let past = 0;
  const tenants = (await listAllTenants()).filter((t) => !ONLY_TENANT || t.id === ONLY_TENANT);
  for (const t of tenants) {
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    const repo = forTenant(ctx);
    const journeys = await repo.lifecycleJourneys.find({ where: [["status", "==", "active"]], limit: 100 });
    for (const j of journeys) {
      if (j.audience?.kind === "waitlist" || !j.publishedVersion) continue;
      const version = await repo.lifecycleVersions.getById(versionDocId(j.id, j.publishedVersion));
      if (!version) continue;
      const windowMs = version.settings.trigger.maxEventAgeHours * 3600_000;
      const active = await repo.lifecycleEnrolments.find({
        where: [
          ["journeyId", "==", j.id],
          ["status", "==", "active"],
        ],
        limit: 5000,
      });
      const h = active.filter((e) => e.sentItems.length === 0 && e.log.at(-1)?.event === "mode_blocked");
      const p = h.filter((e) => nowMs - Date.parse(e.anchorAt) > windowMs);
      held += h.length;
      past += p.length;
      if (h.length) console.log(`[mode-holds] ${t.id} ${j.id} (${j.deliveryMode}): held ${h.length}, past their window ${p.length}`);
    }
  }
  console.log(`[mode-holds] done: held=${held} past-window (will exit)=${past}`);
}

main().catch((err) => {
  console.error("[mode-holds] failed:", err);
  process.exit(1);
});
