/**
 * preview-engine-move.ts — the engine-move DRY RUN for launches (engine move D3,
 * see src/lib/lifecycle/waitlist/preview.ts): for each launch with a welcome
 * journey, whether it converts to the lifecycle engine cleanly (and why not),
 * what it becomes, and how many people it affects. Read-only. Prints counts and
 * issue codes only, never a person or an email's copy.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/preview-engine-move.ts
 * Optional:  --tenant <tenantId>   --campaign <campaignId>
 *
 * Auth = Application Default Credentials (`gcloud auth application-default login`).
 */

// Never touch a local emulator (a dev shell may export these).
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

import { forTenant, listAllTenants } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { previewEngineMove } from "@/lib/lifecycle/waitlist/preview";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const ONLY_TENANT = flag("tenant");
const ONLY_CAMPAIGN = flag("campaign");

async function main() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    console.error("Set GOOGLE_CLOUD_PROJECT to the project whose launches to check.");
    process.exit(1);
  }
  console.log(`[engine-preview] project=${project} (read-only)`);
  let launches = 0;
  let blocked = 0;
  const tenants = (await listAllTenants()).filter((t) => !ONLY_TENANT || t.id === ONLY_TENANT);
  for (const t of tenants) {
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    const campaigns = (await forTenant(ctx).campaigns.find({ limit: 500 })).filter((c) => !ONLY_CAMPAIGN || c.id === ONLY_CAMPAIGN);
    for (const c of campaigns) {
      const p = await previewEngineMove(ctx, c.id);
      if (!p || !p.original.exists) continue;
      launches += 1;
      const r = p.conversion!;
      if (!r.ok) blocked += 1;
      console.log(
        `[engine-preview] ${t.id} ${c.id} (${p.original.status}${p.launch.archived ? ", archived" : ""}): ` +
          `${p.original.emails} emails, ${p.original.peopleInJourney} people mid-journey, ${p.verifiedSignups} verified — ` +
          (r.ok
            ? `converts cleanly (${p.converted!.emails} emails, ${p.converted!.abTests} A/B tests); notes: ${r.notes.map((n) => n.code).join(", ")}`
            : `BLOCKED: ${r.blocking.map((b) => `${b.code}${b.detail ? `(${b.detail})` : ""}${b.nodeId ? `@${b.nodeId}` : ""}`).join(", ")}`),
      );
    }
  }
  console.log(`[engine-preview] done: launches=${launches} blocked=${blocked}`);
}

main().catch((err) => {
  console.error("[engine-preview] failed:", err);
  process.exit(1);
});
