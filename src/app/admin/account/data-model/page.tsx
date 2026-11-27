import { notFound } from "next/navigation";
import { getAdminContextWithHome, requireAdminContext } from "@/lib/auth/session";
import { isFieldFiltersEnabled, isFieldsEnabled, isVizzyTextFieldsEnabled } from "@/lib/audience/peopleFlags";
import { loadPeopleConnections } from "@/lib/audience/personSync";
import { readOnlyFieldDefs } from "@/lib/audience/readOnlyFields";
import { isIdeaWordsEnabled } from "@/lib/ideas/flags";
import { ENVIRONMENT_LABEL, environmentOf, productNameOf } from "@/lib/connect/environments";
import { forTenant } from "@/lib/tenant";
import { DataModel } from "@/components/admin/audience/DataModel";
import { isSettingsEraseEnabled, isSettingsHistoryEnabled } from "@/lib/settings/flags";
import { mayMoveBrand, verifiedPersonOf } from "@/lib/tenant";
import { isRaisePipelineEnabled } from "@/lib/raise/pipeline/flags";
import { RaiseSetupPanel } from "@/components/admin/investors/RaiseSetupPanel";

export const dynamic = "force-dynamic";

/**
 * Settings › Data model (AUDIENCE_FIELDS_ENABLED): the fields on People and Companies. The fields
 * from elsewhere are worked out here, from the brand's launches and products; the brand's own
 * fields load in the browser. Admins change them; members read. The "Vizzy reads" column and
 * "Vizzy can read this field" show while AUDIENCE_VIZZY_TEXT_FIELDS_ENABLED is on. The Changes
 * box points to Settings › History while SETTINGS_HISTORY_ENABLED is on, and an owner with an admin
 * row sees Erase values on archived fields while SETTINGS_ERASE_ENABLED is on. Admins see the
 * Ready-made fields box above the list (Set up for raising or funding) while RAISE_PIPELINE_ENABLED is on.
 */
export default async function DataModelPage() {
  const ctx = await requireAdminContext();
  if (!isFieldsEnabled()) notFound();
  const [campaigns, connections] = await Promise.all([
    forTenant(ctx).campaigns.find({ limit: 500 }).catch(() => []),
    loadPeopleConnections(ctx).catch(() => new Map()),
  ]);
  const named = [...connections.values()].map((c) => {
    const env = environmentOf(c);
    return { id: c.id, catalog: c.catalog, name: `${productNameOf(c)}${env ? ` · ${ENVIRONMENT_LABEL[env]}` : ""}` };
  });
  const sources = { campaigns, connections: named };
  // Erase values: an owner of the organisation with a real admin row for the brand, read live
  // (the check moving a brand makes); everyone else sees Data model as before.
  let eraseOwner = false;
  if (isSettingsEraseEnabled()) {
    const session = await getAdminContextWithHome();
    const person = session ? verifiedPersonOf(session) : null;
    eraseOwner = !!person && (await mayMoveBrand(person, ctx.tenantId).catch(() => ({ ok: false }))).ok;
  }
  const ideas = { ideas: isIdeaWordsEnabled() };
  const model = (
    <DataModel
      canEdit={ctx.role === "admin"}
      filters={isFieldFiltersEnabled()}
      vizzyText={isVizzyTextFieldsEnabled()}
      historyTab={isSettingsHistoryEnabled()}
      eraseOwner={eraseOwner}
      readOnly={{ person: readOnlyFieldDefs("person", sources, ideas), company: readOnlyFieldDefs("company", sources, ideas) }}
    />
  );
  // The box loads the list below again after a press, so it shows the new fields.
  return ctx.role === "admin" && isRaisePipelineEnabled() ? <RaiseSetupPanel>{model}</RaiseSetupPanel> : model;
}
