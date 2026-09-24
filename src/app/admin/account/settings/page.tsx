import { requireAdminContext } from "@/lib/auth/session";
import { getTenantById } from "@/lib/tenant";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";
import { AccountSettings } from "@/components/admin/AccountSettings";

export const dynamic = "force-dynamic";

const REGION: Record<string, string> = { us: "United States", eu: "Europe", asia: "Asia" };

/**
 * Account-wide settings: content-language defaults. With nav v2 phase 3 this is
 * Settings › General, and also shows the brand's details (the ids and data region
 * that used to sit in the sidebar footer).
 */
export default async function AccountSettingsPage() {
  const ctx = await requireAdminContext();
  if (!isNavV2Phase3Enabled()) return <AccountSettings />;
  const tenant = await getTenantById(ctx.tenantId).catch(() => null);
  const rows: Array<[string, string]> = [
    ["Brand", tenant?.tenantName ?? ctx.tenantId],
    ["Primary domain", tenant?.rootDomain || "Not set — add it under Sending"],
    ["Data region", `${REGION[ctx.region] ?? ctx.region} (can't be changed)`],
    ["Brand ID", ctx.tenantId],
  ];
  return (
    <div className="space-y-6">
      <section className="max-w-2xl space-y-2">
        <h2 className="text-sm font-semibold">Brand details</h2>
        <dl className="divide-y divide-neutral-100 rounded-md border border-neutral-200 text-sm dark:divide-neutral-900 dark:border-neutral-800">
          {rows.map(([k, v]) => (
            <div key={k} className="flex gap-4 px-4 py-2.5">
              <dt className="w-36 shrink-0 text-neutral-500 dark:text-neutral-400">{k}</dt>
              <dd className={k === "Brand ID" ? "font-mono text-xs leading-5" : ""}>{v}</dd>
            </div>
          ))}
        </dl>
      </section>
      <AccountSettings />
    </div>
  );
}
