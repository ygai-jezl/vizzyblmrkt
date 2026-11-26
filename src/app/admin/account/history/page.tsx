import { notFound } from "next/navigation";
import { getAdminContextWithHome, requireAdminContext } from "@/lib/auth/session";
import { isSettingsEraseEnabled, isSettingsHistoryEnabled } from "@/lib/settings/flags";
import { shownKinds } from "@/lib/settings/sources";
import { getTenantById, mayMoveBrand, verifiedPersonOf } from "@/lib/tenant";
import { HistoryView } from "@/components/admin/settings/HistoryView";
import { HISTORY_COPY, kindsInWords } from "@/components/admin/settings/historyWords";

export const dynamic = "force-dynamic";

/**
 * Settings › History (SETTINGS_HISTORY_ENABLED): every change to the brand's fields, journeys,
 * product catalogs and shared connections, for the brand you are in. The whole team reads it and
 * exports; admins preview and restore. The kinds listed are those whose own screens are on. While
 * SETTINGS_ERASE_ENABLED is on, an owner of the organisation with a real admin row for the brand
 * (read live, as Data model reads it) sees Erase values on the entry that archived a field.
 */
export default async function HistoryPage() {
  const ctx = await requireAdminContext();
  if (!isSettingsHistoryEnabled()) notFound();
  const brand = await getTenantById(ctx.tenantId).catch(() => null);
  const lead = HISTORY_COPY.lead(kindsInWords(shownKinds()), brand?.tenantName ?? "this brand");
  let eraseOwner = false;
  if (isSettingsEraseEnabled()) {
    const session = await getAdminContextWithHome();
    const person = session ? verifiedPersonOf(session) : null;
    eraseOwner = !!person && (await mayMoveBrand(person, ctx.tenantId).catch(() => ({ ok: false }))).ok;
  }
  return <HistoryView canRestore={ctx.role === "admin"} lead={lead} eraseOwner={eraseOwner} />;
}
