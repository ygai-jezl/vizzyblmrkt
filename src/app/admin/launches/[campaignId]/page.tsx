import Link from "next/link";
import { requireAdminContext } from "@/lib/auth/session";
import { computeCampaignAnalytics } from "@/lib/analytics/analytics";
import { forTenant } from "@/lib/tenant";
import { journeyIdFor } from "@/lib/journey/service";
import { launchEmails } from "@/lib/journey/launchEmails";
import { isNavV2Phase4Enabled } from "@/lib/nav/flags";
import { launchChecklist } from "@/lib/nav/launchChecklist";
import { isInvitesEnabled, isInvitesUiEnabled } from "@/lib/invites/flags";
import { INVITE_LOCK_TEXT } from "@/lib/invites/lockText";
import { loadInviteSetup } from "@/lib/invites/waves";
import { loadFunnel } from "@/lib/invites/funnel";
import { LaunchChecklist } from "@/components/admin/LaunchChecklist";

export const dynamic = "force-dynamic";

/**
 * Compact launch overview: a few headline KPIs (the full breakdown lives in the
 * Analytics tab) plus quick links into the launch's tools. The campaign is
 * guaranteed to exist by the parent layout.
 */
export default async function LaunchOverviewPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const ctx = await requireAdminContext();
  const { campaignId } = await params;
  const a = await computeCampaignAnalytics(ctx, campaignId);
  const base = `/admin/launches/${campaignId}`;
  const checklist = isNavV2Phase4Enabled() ? await loadChecklist(ctx, campaignId, a.totalSignups) : null;

  return (
    <div className="space-y-6">
      {checklist ? <LaunchChecklist steps={checklist} /> : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Total signups" value={a.totalSignups} hint="verified + unverified" />
        <Tile label="Verified" value={a.verifiedSignups} />
        <Tile label="Total referrals" value={a.totalReferrals} />
        <Tile label="Last signup" value={relative(a.lastSignupAt)} small />
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        <Quick href={`${base}/signups`}>View signups</Quick>
        <Quick href={`${base}/analytics`}>Full analytics</Quick>
        <Quick href={`${base}/widget`}>Get embed widget</Quick>
        <Quick href={`${base}/settings`}>Edit settings</Quick>
        <Quick href={`/waitlist/${campaignId}`}>Open hosted page ↗</Quick>
      </div>
    </div>
  );
}

/** Nav v2 phase 4: the checklist's inputs. Every read fails soft (a step just shows as not done). */
async function loadChecklist(ctx: Awaited<ReturnType<typeof requireAdminContext>>, campaignId: string, signups: number) {
  const repos = forTenant(ctx);
  const invitesOn = isInvitesUiEnabled() && isInvitesEnabled();
  const [campaign, journey, broadcasts, inviteSetup, funnel] = await Promise.all([
    repos.campaigns.getById(campaignId).catch(() => null),
    repos.journeys.getById(journeyIdFor(campaignId)).catch(() => null),
    repos.broadcasts.find({ where: [["campaignId", "==", campaignId]] }).catch(() => []),
    invitesOn ? loadInviteSetup(ctx, campaignId).catch(() => null) : null,
    invitesOn ? loadFunnel(ctx, { campaignId }).catch(() => null) : null,
  ]);
  return launchChecklist({
    campaignId,
    signups,
    embeddedAt: campaign?.waitlistUrlLocation ?? null,
    welcomeLive: journey?.status === "active",
    spotsPerReferral: campaign?.spotsToMoveUponReferral ?? 0,
    newslettersSent: launchEmails(journey, broadcasts).newsletters.sent,
    invites: inviteSetup
      ? {
          lockText: inviteSetup.lock ? INVITE_LOCK_TEXT[inviteSetup.lock] : null,
          invited: funnel?.invited ?? 0,
          signedUp: funnel?.signedUp ?? 0,
        }
      : null,
  });
}

function Tile({
  label,
  value,
  hint,
  small,
}: {
  label: string;
  value: number | string;
  hint?: string;
  small?: boolean;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className={small ? "mt-1 text-base font-medium" : "mt-1 text-2xl font-semibold tabular-nums"}>
        {value}
      </div>
      {hint ? <div className="text-xs text-neutral-400">{hint}</div> : null}
    </div>
  );
}

function Quick({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
    >
      {children}
    </Link>
  );
}

function relative(iso: string | null): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
