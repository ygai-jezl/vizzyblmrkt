import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { LaunchTabs } from "@/components/admin/LaunchTabs";
import { InviteButton } from "@/components/admin/invites/InviteButton";
import { isInvitesEnabled, isInvitesUiEnabled } from "@/lib/invites/flags";
import { INVITE_LOCK_TEXT } from "@/lib/invites/lockText";
import { loadInviteSetup } from "@/lib/invites/waves";

export const dynamic = "force-dynamic";

/**
 * Launch (campaign) workspace shell. Resolves the campaign once and renders the
 * launch header + sub-tabs; each tab surfaces an existing waitlist tool scoped
 * to this launch. The campaign existence is enforced here, so the tab pages can
 * assume it exists.
 */
export default async function LaunchLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ campaignId: string }>;
}) {
  const ctx = await requireAdminContext();
  const { campaignId } = await params;
  const campaign = await forTenant(ctx).campaigns.getById(campaignId);
  if (!campaign) notFound();
  // Nav v2 phase 4: "Invite waitlist to product", locked (with the reason) until
  // there's a live production product with a sign-up link. Fails soft to hidden.
  const invites =
    isInvitesUiEnabled() && isInvitesEnabled()
      ? await loadInviteSetup(ctx, campaign.id).catch(() => null)
      : null;

  const header = (
    <div className="space-y-1">
      <p className="text-xs uppercase tracking-wide text-neutral-400">Launch</p>
      <h1 className="text-xl font-semibold">{campaign.waitlistName}</h1>
      <p className="text-sm text-neutral-500">
        /{campaign.id} · hosted at{" "}
        <code className="text-neutral-600 dark:text-neutral-400">/waitlist/{campaign.id}</code>
      </p>
    </div>
  );

  return (
    <div className="space-y-6">
      {invites ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          {header}
          <InviteButton campaignId={campaign.id} lockText={invites.lock ? INVITE_LOCK_TEXT[invites.lock] : null} />
        </div>
      ) : (
        header
      )}
      <LaunchTabs campaignId={campaign.id} />
      <div>{children}</div>
    </div>
  );
}
