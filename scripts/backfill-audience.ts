import { listAllTenants, getTenantById, forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import {
  resolveMailchimpConfig,
  syncSignupToAudience,
  campaignTag,
} from "@/lib/mailchimp";

/**
 * One-time backfill: upsert existing verified_active subscribers into the shared
 * MailChimp Marketing audience, tagged per launch (`waitlist-<campaignId>`). The
 * live signup/verify paths sync NEW subscribers automatically — this covers
 * everyone who joined while MailChimp Marketing was unconfigured (so the tag's
 * static segment never came into existence). Without it, a Broadcast throws
 * `no_audience_segment_for_launch` even once the keys are provisioned.
 *
 * Usage — prod uses the SAME shared MailChimp account as dev, so source the
 * MAILCHIMP_* vars from .env.local (this script does not load dotenv):
 *   set -a; source .env.local; set +a
 *   GOOGLE_CLOUD_PROJECT=vizzybl-marketing-prod npx tsx scripts/backfill-audience.ts            # dry run (default)
 *   GOOGLE_CLOUD_PROJECT=vizzybl-marketing-prod npx tsx scripts/backfill-audience.ts --apply    # actually sync
 * Optional filters:  --tenant <tenantId>   --campaign <campaignId>
 *
 * Idempotent: the MailChimp member upsert is a PUT — safe to re-run. Needs ADC
 * (`gcloud auth application-default login`) with read access to the project's
 * Firestore databases (default + signups-eu + signups-asia).
 */

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const APPLY = process.argv.includes("--apply");
const ONLY_TENANT = flag("tenant");
const ONLY_CAMPAIGN = flag("campaign");

async function main() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    console.error("Set GOOGLE_CLOUD_PROJECT (e.g. vizzybl-marketing-prod).");
    process.exit(1);
  }
  if (!process.env.MAILCHIMP_API_KEY || !process.env.MAILCHIMP_AUDIENCE_ID) {
    console.error(
      "MAILCHIMP_API_KEY / MAILCHIMP_AUDIENCE_ID not set. Source the shared-account\n" +
        "env first:  set -a; source .env.local; set +a",
    );
    process.exit(1);
  }
  console.log(
    `[backfill] project=${project} mode=${APPLY ? "APPLY" : "dry-run"}` +
      `${ONLY_TENANT ? ` tenant=${ONLY_TENANT}` : ""}` +
      `${ONLY_CAMPAIGN ? ` campaign=${ONLY_CAMPAIGN}` : ""}`,
  );

  const tenants = (await listAllTenants()).filter(
    (t) => !ONLY_TENANT || t.id === ONLY_TENANT,
  );
  let synced = 0;
  let failed = 0;
  let noEmail = 0;

  for (const t of tenants) {
    const ctx: TenantContext = {
      tenantId: t.id,
      region: t.region,
      source: "system",
    };
    // Pre-flight the audience config once per tenant. Skip (rather than hammer a
    // per-signup failure) when it can't resolve — e.g. a BYO tenant with no key.
    const tenant = await getTenantById(t.id).catch(() => null);
    const cfg = resolveMailchimpConfig(tenant);
    if (!cfg.ok) {
      console.warn(
        `[backfill] ${t.id} (${t.region}): SKIP — audience config ${cfg.reason}`,
      );
      continue;
    }

    const campaigns = (await forTenant(ctx).campaigns.find({})).filter(
      (c) => !ONLY_CAMPAIGN || c.id === ONLY_CAMPAIGN,
    );
    for (const c of campaigns) {
      const subs = await forTenant(ctx).signups.find({
        where: [
          ["campaignId", "==", c.id],
          ["status", "==", "verified_active"],
        ],
      });
      const withEmail = subs.filter((s) => s.email);
      noEmail += subs.length - withEmail.length;
      console.log(
        `[backfill] ${t.id}/${c.id}: ${withEmail.length} verified subscriber(s) ` +
          `→ tag ${campaignTag(c.id)}`,
      );
      if (!APPLY) {
        synced += withEmail.length; // dry-run: count what WOULD sync
        continue;
      }
      // Sequential on purpose: a one-time job, well under MailChimp's rate caps,
      // and easy to read in the log if a single address rejects.
      for (const s of withEmail) {
        const r = await syncSignupToAudience(ctx, c, s);
        if (r.ok) {
          synced += 1;
        } else {
          failed += 1;
          console.warn(`  ✗ ${s.email}: ${r.reason}`);
        }
      }
    }
  }

  console.log(
    `[backfill] done — ${APPLY ? "synced" : "would sync"} ${synced}, ` +
      `failed ${failed}, skipped(no-email) ${noEmail}`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
