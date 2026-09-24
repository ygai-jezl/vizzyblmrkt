/**
 * check-double-sends.ts — the ZERO-DOUBLE-SEND check for the engine move (see
 * src/lib/lifecycle/waitlist/engineSwitch.ts): for every launch that has run on
 * the lifecycle engine, how many signups have had welcome emails from BOTH the
 * original engine and the lifecycle engine. Must be 0. Read-only; prints counts
 * only, never a person.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/check-double-sends.ts
 * Optional:  --tenant <tenantId>   --campaign <campaignId>
 *
 * Auth = Application Default Credentials (`gcloud auth application-default login`).
 */

// Never touch a local emulator (a dev shell may export these).
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

import { forTenant, listAllTenants } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { countDoubleSends } from "@/lib/lifecycle/waitlist/engineSwitch";
import { waitlistJourneyId } from "@/lib/lifecycle/waitlist/ids";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const ONLY_TENANT = flag("tenant");
const ONLY_CAMPAIGN = flag("campaign");

async function main() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    console.error("Set GOOGLE_CLOUD_PROJECT to the project to check.");
    process.exit(1);
  }
  console.log(`[double-sends] project=${project} (read-only)`);
  let launches = 0;
  let total = 0;
  const tenants = (await listAllTenants()).filter((t) => !ONLY_TENANT || t.id === ONLY_TENANT);
  for (const t of tenants) {
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    const campaigns = (await forTenant(ctx).campaigns.find({ limit: 500 })).filter((c) => !ONLY_CAMPAIGN || c.id === ONLY_CAMPAIGN);
    for (const c of campaigns) {
      const moved = c.waitlistEngine && c.waitlistEngine !== "legacy"
        ? true
        : Boolean(await forTenant(ctx).lifecycleJourneys.getById(waitlistJourneyId(c.id)));
      if (!moved) continue;
      launches += 1;
      const n = await countDoubleSends(ctx, c.id);
      total += n;
      console.log(`[double-sends] ${t.id} ${c.id} (${c.waitlistEngine ?? "legacy"}): ${n}${n ? "  <<< CHECK" : ""}`);
    }
  }
  console.log(`[double-sends] done: launches=${launches} people with both=${total}${total ? "  <<< CHECK" : " (none)"}`);
  if (total) process.exitCode = 2;
}

main().catch((err) => {
  console.error("[double-sends] failed:", err);
  process.exit(1);
});
