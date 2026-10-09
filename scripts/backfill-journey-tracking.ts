/**
 * backfill-journey-tracking.ts — switch opens and clicks on for the product journeys
 * a brand already has (LIFECYCLE_SEND_TRACKING). New product journeys start tracked;
 * this covers the ones made while tracking was off by default.
 *
 * It sets the journey's live tracking and its draft's, so the next email to everyone
 * in the journey is tracked without a republish (a published version is never
 * changed). Launch journeys already track; archived ones are left alone.
 *
 * DRY RUN by default. Pass --apply to write.
 *
 * Safe to re-run: it only touches a journey that has no live tracking setting yet —
 * one made before this switch and not published since. A journey whose live setting
 * is off was switched off on purpose (in the editor, then published) after that, so
 * it is listed and left alone; pass --all to switch those on too.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/backfill-journey-tracking.ts --tenant <tenantId>
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/backfill-journey-tracking.ts --tenant <tenantId> --apply
 *
 * --tenant is required: tracking changes what a brand's emails carry (a pixel, and
 * rewritten links), so it is switched on one brand at a time, never for everyone.
 *
 * Auth = Application Default Credentials (`gcloud auth application-default login`).
 */

// Never touch a local emulator (a dev shell may export these).
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

import { forTenant, getTenantById } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { isWaitlistJourney } from "@/lib/types/lifecycle";

const APPLY = process.argv.includes("--apply");
const ALL = process.argv.includes("--all");
const ON = { opens: true, clicks: true };
/** How many journeys one read asks for: a brand with more than this is told so, not cut short in silence. */
const PAGE = 500;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const both = (t: { opens: boolean; clicks: boolean } | null | undefined) => Boolean(t?.opens && t.clicks);
const shown = (t: { opens: boolean; clicks: boolean } | null | undefined) => (t ? `opens ${t.opens ? "on" : "off"}, clicks ${t.clicks ? "on" : "off"}` : "not set");

async function main() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const tenantId = flag("tenant");
  if (!project || !tenantId) {
    console.error("Set GOOGLE_CLOUD_PROJECT and pass --tenant <tenantId>.");
    process.exit(1);
  }
  const tenant = await getTenantById(tenantId);
  if (!tenant) {
    console.error(`[tracking] no tenant ${tenantId} in ${project}`);
    process.exit(1);
  }
  console.log(`[tracking] project=${project} tenant=${tenantId} mode=${APPLY ? "APPLY" : "dry-run"}`);

  const ctx: TenantContext = { tenantId: tenant.id, region: tenant.region, source: "system" };
  const repo = forTenant(ctx).lifecycleJourneys;
  const found = await repo.find({ limit: PAGE });
  if (found.length >= PAGE) {
    console.warn(`[tracking] this brand has ${PAGE} journeys or more: only the first ${PAGE} were looked at.`);
  }
  const journeys = found.filter((j) => !isWaitlistJourney(j) && j.status !== "archived");
  let changed = 0;
  let left = 0;
  for (const j of journeys) {
    if (both(j.tracking) && both(j.draft.settings.tracking)) {
      console.log(`  = ${j.id} "${j.name}" (${j.status}): already tracking`);
      continue;
    }
    // It has a live setting, so it was published (or its draft changed) since tracking came in: someone's choice.
    if (j.tracking && !ALL) {
      console.log(`  - ${j.id} "${j.name}" (${j.status}): set since (live ${shown(j.tracking)}; draft ${shown(j.draft.settings.tracking)}); left alone, --all to switch it on`);
      left += 1;
      continue;
    }
    console.log(`  + ${j.id} "${j.name}" (${j.status}): live ${shown(j.tracking)}; draft ${shown(j.draft.settings.tracking)}`);
    changed += 1;
    if (!APPLY) continue;
    const now = new Date().toISOString();
    await repo.claim(j.id, (cur) => ({
      tracking: ON,
      draft: { ...cur.draft, settings: { ...cur.draft.settings, tracking: ON } },
      updatedAt: now,
    }));
  }
  console.log(
    `[tracking] ${journeys.length} product journeys, ${changed} ${APPLY ? "switched on" : "to switch on (run again with --apply)"}${left ? `, ${left} left off on purpose` : ""}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
