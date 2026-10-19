/**
 * seal-mailchimp-keys.ts — seal the own Mailchimp keys brands saved before
 * MAILCHIMP_KEY_SEALED_ENABLED was on: a plain `mailchimpConfig.apiKey` becomes
 * `mailchimpConfig.apiKeyEnc` (src/lib/mailchimp/keyBox.ts) and the plain field
 * is deleted. New saves are sealed by the settings route; this covers the rest.
 *
 * DRY RUN by default: names the brands holding a plain key, never the key. Pass
 * --apply to write. Idempotent: brands already sealed, or with no key, are left
 * alone. Each brand is sealed in a transaction (sealTenantMailchimpKey), and the
 * sealed copy is opened and compared before the plain one is deleted.
 *
 * Turn the switch on for the project first, so a save can't write plain text again.
 * --apply needs that project's root secret, read straight from Secret Manager:
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/seal-mailchimp-keys.ts
 *   MAILCHIMP_KEY_ENC_KEY="$(gcloud secrets versions access latest \
 *       --secret=mailchimp-key-enc-key --project=<your-project>)" \
 *     GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/seal-mailchimp-keys.ts --apply
 *
 * Auth = Application Default Credentials (`gcloud auth application-default login`).
 */

// Never touch a local emulator (a dev shell may export these).
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

import { listAllTenants, sealTenantMailchimpKey } from "@/lib/tenant";
import {
  isMailchimpKeyBoxConfigured,
  readOwnMailchimpKey,
  sealMailchimpKey,
} from "@/lib/mailchimp/keyBox";

const APPLY = process.argv.includes("--apply");

/** Seal, then prove the sealed copy opens back to the same key before it's stored. */
function checkedSeal(tenantId: string) {
  return (plainKey: string) => {
    const apiKeyEnc = sealMailchimpKey(tenantId, plainKey);
    const back = readOwnMailchimpKey(tenantId, { requiresOwnApiKey: false, apiKeyEnc });
    if (!back.ok || back.apiKey !== plainKey) throw new Error("round_trip_mismatch");
    return apiKeyEnc;
  };
}

async function main() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    console.error("Set GOOGLE_CLOUD_PROJECT (e.g. vizzybl-marketing-dev).");
    process.exit(1);
  }
  if (APPLY && !isMailchimpKeyBoxConfigured()) {
    console.error("MAILCHIMP_KEY_ENC_KEY is not set. See the usage at the top of this file.");
    process.exit(1);
  }
  console.log(`[seal-mailchimp-keys] project=${project} mode=${APPLY ? "APPLY" : "dry-run"}`);

  const tenants = await listAllTenants();
  const plain = tenants.filter(
    (t) => !t.mailchimpConfig?.apiKeyEnc && t.mailchimpConfig?.apiKey?.trim(),
  );
  let sealed = 0;
  let failed = 0;

  for (const t of plain) {
    if (!APPLY) {
      console.log(`  ${t.id}: plain key, would seal`);
      continue;
    }
    try {
      const did = await sealTenantMailchimpKey(t.id, checkedSeal(t.id));
      if (did) sealed += 1;
      console.log(`  ${t.id}: ${did ? "sealed" : "skipped (changed since the scan)"}`);
    } catch (err) {
      failed += 1;
      console.error(`  ${t.id}: FAILED (${(err as Error).message})`);
    }
  }

  console.log(
    `[seal-mailchimp-keys] brands=${tenants.length} plain=${plain.length}` +
      (APPLY ? ` sealed=${sealed} failed=${failed}` : ""),
  );
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
