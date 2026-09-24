/**
 * recover-paused-journeys.ts — find (and optionally recover) people whose
 * waitlist welcome journey stopped because it was paused, or its launch
 * archived, before engine move D1 (see src/lib/journey/recoverPaused.ts).
 *
 * DRY RUN by default: prints, per launch, how many people are stranded and when.
 * Pass --apply to put their missed step back in the queue; they get it and the
 * rest of the sequence follows, spread across worker ticks. Only journeys that
 * are sending are recovered; a paused one is listed as "resume, then run again".
 * Idempotent. Prints counts and dates only, never a person.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/recover-paused-journeys.ts
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/recover-paused-journeys.ts --apply
 * Optional:  --tenant <tenantId>   --campaign <campaignId>
 *
 * Auth = Application Default Credentials (`gcloud auth application-default login`).
 */

// Never touch a local emulator (a dev shell may export these).
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

import { forTenant, listAllTenants } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { recoverPausedJourney } from "@/lib/journey/recoverPaused";

const APPLY = process.argv.includes("--apply");

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const ONLY_TENANT = flag("tenant");
const ONLY_CAMPAIGN = flag("campaign");
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

async function main() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    console.error("Set GOOGLE_CLOUD_PROJECT to the project whose journeys to check.");
    process.exit(1);
  }
  console.log(`[recover] project=${project} mode=${APPLY ? "APPLY" : "dry-run"}`);

  let stranded = 0;
  let recovered = 0;
  const tenants = (await listAllTenants()).filter((t) => !ONLY_TENANT || t.id === ONLY_TENANT);
  for (const t of tenants) {
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    const campaigns = (await forTenant(ctx).campaigns.find({ limit: 500 })).filter(
      (c) => !ONLY_CAMPAIGN || c.id === ONLY_CAMPAIGN,
    );
    for (const c of campaigns) {
      const r = await recoverPausedJourney(ctx, c.id, { apply: APPLY });
      const found = r.emailSteps + r.conditionSteps;
      if (!found) continue;
      stranded += found;
      recovered += r.recovered;
      const action = r.waitingForResume
        ? "journey not sending: resume it, then run again"
        : APPLY
          ? `recovered ${r.recovered}`
          : "would recover";
      console.log(
        `[recover] ${t.id} ${c.id} (${r.journeyStatus}): ${r.emailSteps} at an email, ${r.conditionSteps} at a condition; stranded ${day(r.oldest)} → ${day(r.newest)} — ${action}`,
      );
    }
  }
  console.log(
    `[recover] done: stranded=${stranded} ${APPLY ? `recovered=${recovered}` : "(dry run — pass --apply to recover)"}`,
  );
}

main().catch((err) => {
  console.error("[recover] failed:", err);
  process.exit(1);
});
