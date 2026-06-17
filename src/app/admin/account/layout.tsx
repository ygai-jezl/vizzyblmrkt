import { requireAdminContext } from "@/lib/auth/session";
import { AccountTabs } from "@/components/admin/AccountTabs";

export const dynamic = "force-dynamic";

/**
 * Account Settings shell. These are global, tenant-wide settings reused across
 * every launch (unlike per-launch settings under /admin/launches/[id]/settings).
 * Auth is enforced here so the tab pages can assume an admin context.
 */
export default async function AccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAdminContext();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-neutral-400">Account</p>
        <h1 className="text-xl font-semibold">Account settings</h1>
        <p className="text-sm text-neutral-500">
          Global settings for your account, reused across all of your launches.
        </p>
      </div>
      <AccountTabs />
      <div>{children}</div>
    </div>
  );
}
