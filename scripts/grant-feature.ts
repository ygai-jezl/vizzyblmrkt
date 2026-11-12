/**
 * grant-feature.ts: give one brand a feature this copy keeps for granted brands, or take it
 * away (GRANTED_ONLY_FEATURES; see src/lib/plans/brandAccess.ts). Until billing sets them, this
 * is how a managed copy decides which brands get a costly feature such as edit_vizzy_learning.
 *
 * DRY RUN by default: it says what the brand has and what would change. Pass --apply to write.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/grant-feature.ts --tenant <tenantId> --feature edit_vizzy_learning
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/grant-feature.ts --tenant <tenantId> --feature edit_vizzy_learning --apply
 * Optional:  --remove  (take the feature away)
 *
 * Auth = Application Default Credentials (`gcloud auth application-default login`).
 */

// Never touch a local emulator (a dev shell may export these).
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

import { getTenantById } from "@/lib/tenant";
import { setTenantFeatureGrant } from "@/lib/tenant/control";
import { METERED_FEATURES, type MeteredFeature } from "@/lib/plans/brandAccess";

const APPLY = process.argv.includes("--apply");
const REMOVE = process.argv.includes("--remove");

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const tenantId = flag("tenant");
  const feature = flag("feature");
  if (!project || !tenantId || !feature) {
    console.error("Set GOOGLE_CLOUD_PROJECT, and pass --tenant <tenantId> --feature <feature>.");
    process.exit(1);
  }
  if (!(METERED_FEATURES as readonly string[]).includes(feature)) {
    console.error(`Unknown feature "${feature}". Features: ${METERED_FEATURES.join(", ")}.`);
    process.exit(1);
  }
  const tenant = await getTenantById(tenantId);
  if (!tenant) {
    console.error(`No brand "${tenantId}" in ${project}.`);
    process.exit(1);
  }
  const has = tenant.grantedFeatures?.includes(feature as MeteredFeature) ?? false;
  console.log(`[grant-feature] project=${project} brand=${tenantId} feature=${feature} has it now: ${has ? "yes" : "no"}`);
  if (has === !REMOVE) {
    console.log("[grant-feature] nothing to change");
    return;
  }
  if (!APPLY) {
    console.log(`[grant-feature] would ${REMOVE ? "take it away" : "grant it"} (dry run: pass --apply to write)`);
    return;
  }
  const after = await setTenantFeatureGrant(tenantId, feature, !REMOVE);
  console.log(`[grant-feature] done: the brand's granted features are now [${(after ?? []).join(", ")}]`);
}

main().catch((err) => {
  console.error("[grant-feature] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
