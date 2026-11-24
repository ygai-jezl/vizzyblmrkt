import { requireAdminContext } from "@/lib/auth/session";
import { AccountTabs } from "@/components/admin/AccountTabs";
import { isNavV2Enabled } from "@/lib/nav/flags";
import { isFieldsEnabled } from "@/lib/audience/peopleFlags";
import { loadOrganisationOwner } from "@/lib/connectors/organisationPage";

export const dynamic = "force-dynamic";

/**
 * Account Settings shell. These are global, tenant-wide settings reused across
 * every launch (unlike per-launch settings under /admin/launches/[id]/settings).
 * Auth is enforced here so the tab pages can assume an admin context. The Organisation tab shows
 * only to an owner of the brand's organisation who is an admin of the brand they are in, read live
 * on the server while sharing is on (Connectors 3), so flipping it needs no new build.
 */
export default async function AccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAdminContext();
  const organisation = Boolean(await loadOrganisationOwner());

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-neutral-400">Account</p>
        <h1 className="text-xl font-semibold">{isNavV2Enabled() ? "Settings" : "Account settings"}</h1>
        <p className="text-sm text-neutral-500">
          Global settings for your account, reused across all of your launches.
        </p>
      </div>
      <AccountTabs dataModel={isFieldsEnabled()} organisation={organisation} />
      <div>{children}</div>
    </div>
  );
}
