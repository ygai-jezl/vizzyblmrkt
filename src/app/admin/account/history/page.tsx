import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { isSettingsHistoryEnabled } from "@/lib/settings/flags";
import { shownKinds } from "@/lib/settings/sources";
import { getTenantById } from "@/lib/tenant";
import { HistoryView } from "@/components/admin/settings/HistoryView";
import { HISTORY_COPY, kindsInWords } from "@/components/admin/settings/historyWords";

export const dynamic = "force-dynamic";

/**
 * Settings › History (SETTINGS_HISTORY_ENABLED): every change to the brand's fields, journeys,
 * product catalogs and shared connections, for the brand you are in. The whole team reads it and
 * exports; admins preview and restore. The kinds listed are those whose own screens are on.
 */
export default async function HistoryPage() {
  const ctx = await requireAdminContext();
  if (!isSettingsHistoryEnabled()) notFound();
  const brand = await getTenantById(ctx.tenantId).catch(() => null);
  const lead = HISTORY_COPY.lead(kindsInWords(shownKinds()), brand?.tenantName ?? "this brand");
  return <HistoryView canRestore={ctx.role === "admin"} lead={lead} />;
}
