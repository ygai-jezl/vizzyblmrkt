import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { isInvitesEnabled, isInvitesUiEnabled } from "@/lib/invites/flags";
import { getLaunchInvites } from "@/lib/invites/adminApi";
import { InvitesClient, type LaunchInvitesView } from "@/components/admin/invites/InvitesClient";

export const dynamic = "force-dynamic";

/**
 * Launches › {launch} › Emails › Invites (nav v2 phase 4): invite the waitlist
 * into the connected product, in waves, and follow them through to activated.
 */
export default async function LaunchInvitesPage({
  params,
  searchParams,
}: {
  params: Promise<{ campaignId: string }>;
  searchParams: Promise<{ wave?: string }>;
}) {
  if (!isInvitesUiEnabled() || !isInvitesEnabled()) notFound();
  const ctx = await requireAdminContext();
  const { campaignId } = await params;
  const { wave } = await searchParams;
  const r = await getLaunchInvites(ctx, campaignId);
  if (r.status !== 200) notFound();
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Invite your waitlist</h2>
        <p className="text-sm text-neutral-500">
          Invite people from the top of your waitlist into your product. Each person leaves the waitlist when their
          invite is sent, and you&apos;ll see who signs up and finishes onboarding.
        </p>
      </div>
      <InvitesClient
        campaignId={campaignId}
        initial={r.body as LaunchInvitesView}
        canSend={ctx.role === "admin"}
        myEmail={ctx.email ?? null}
        initialWaveId={wave ?? null}
      />
    </div>
  );
}
