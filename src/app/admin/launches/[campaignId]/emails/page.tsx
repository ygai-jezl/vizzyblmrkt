import Link from "next/link";
import { notFound } from "next/navigation";
import { Mail, Megaphone, Newspaper, Route, Send } from "lucide-react";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { journeyIdFor } from "@/lib/journey/service";
import { launchEmails, percent, type SentSummary } from "@/lib/journey/launchEmails";
import { WAITLIST_STATUS_LABEL } from "@/lib/journey/waitlistJourneys";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";
import { isInvitesEnabled, isInvitesUiEnabled } from "@/lib/invites/flags";
import { INVITE_LOCK_TEXT } from "@/lib/invites/lockText";
import { loadInviteSetup } from "@/lib/invites/waves";
import { inviteProgressLine, loadFunnel } from "@/lib/invites/funnel";

export const dynamic = "force-dynamic";

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

function sentLine(s: SentSummary, noun: string): string {
  if (!s.sent && !s.scheduled && !s.drafts) return `No ${noun}s yet.`;
  const parts = [
    s.sent ? `${s.sent} sent` : null,
    s.scheduled ? `${s.scheduled} scheduled` : null,
    s.drafts ? `${s.drafts} draft${s.drafts === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  const latest = s.latest
    ? ` · latest “${s.latest.name}”, ${day(s.latest.sentAt)}${percent(s.latest.openRate) ? `, ${percent(s.latest.openRate)} opened` : ""}`
    : "";
  return `${parts.join(" · ")}${latest}`;
}

function Row({
  icon,
  title,
  badge,
  line,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  badge?: React.ReactNode;
  line: string;
  action: React.ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {title}
          {badge}
        </p>
        <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">{line}</p>
      </div>
      {action}
    </li>
  );
}

const BUTTON =
  "shrink-0 rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900";

/**
 * A launch's Emails tab (nav v2 phase 3): everything it sends in one place — the
 * welcome & nurture journey, broadcasts, and weekly newsletters sent from Content.
 * Each row opens where that email is edited.
 */
export default async function LaunchEmailsPage({ params }: { params: Promise<{ campaignId: string }> }) {
  if (!isNavV2Phase3Enabled()) notFound();
  const ctx = await requireAdminContext();
  const { campaignId } = await params;
  const repos = forTenant(ctx);
  const showInvites = isInvitesUiEnabled() && isInvitesEnabled();
  const [journey, broadcasts, workspaces, inviteSetup, funnel] = await Promise.all([
    repos.journeys.getById(journeyIdFor(campaignId)),
    repos.broadcasts.find({ where: [["campaignId", "==", campaignId]], orderBy: [["createdAt", "desc"]] }),
    repos.workspaces.find({ where: [], limit: 200 }).catch(() => []),
    showInvites ? loadInviteSetup(ctx, campaignId).catch(() => null) : null,
    showInvites ? loadFunnel(ctx, { campaignId }).catch(() => null) : null,
  ]);
  const emails = launchEmails(journey, broadcasts);
  const base = `/admin/launches/${campaignId}`;
  const names = new Map(workspaces.map((w) => [w.id, w.name]));
  const source = emails.newsletters.workspaceIds[0];
  const status = emails.journey.status;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Emails</h2>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Everything this launch sends. Each one opens where it&rsquo;s edited.
        </p>
      </div>
      <ul className="space-y-2">
        <Row
          icon={<Route size={17} aria-hidden />}
          title="Welcome & nurture"
          badge={
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                status === "active"
                  ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300"
                  : status === "paused"
                    ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                    : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
              }`}
            >
              {WAITLIST_STATUS_LABEL[status]}
            </span>
          }
          line={
            emails.journey.emails
              ? `Automated · ${emails.journey.emails} email${emails.journey.emails === 1 ? "" : "s"} for everyone who joins`
              : "Automated emails for everyone who joins. Not set up yet."
          }
          action={
            <Link href={`${base}/journey`} className={BUTTON}>
              {emails.journey.emails ? "Edit journey" : "Set it up"}
            </Link>
          }
        />
        <Row
          icon={<Megaphone size={17} aria-hidden />}
          title="Broadcasts"
          line={sentLine(emails.broadcasts, "broadcast")}
          action={
            <Link href={`${base}/broadcasts`} className={BUTTON}>
              {emails.broadcasts.sent || emails.broadcasts.scheduled || emails.broadcasts.drafts ? "Open broadcasts" : "Write one"}
            </Link>
          }
        />
        <Row
          icon={<Newspaper size={17} aria-hidden />}
          title="Weekly newsletter"
          line={
            emails.newsletters.sent
              ? `From ${names.get(source ?? "") ?? "Content"} · ${sentLine(emails.newsletters, "newsletter")}`
              : "Send a weekly newsletter to this waitlist from a content programme."
          }
          action={
            <Link href={source ? `/admin/workspace/${source}/weekly` : "/admin/workspace"} className={BUTTON}>
              {source ? "Open in Content" : "Go to Content"}
            </Link>
          }
        />
        {inviteSetup ? (
          <Row
            icon={<Send size={17} aria-hidden />}
            title="Invites into your product"
            line={
              inviteSetup.lock
                ? INVITE_LOCK_TEXT[inviteSetup.lock]
                : funnel && funnel.invited > 0
                  ? inviteProgressLine(funnel)
                  : "Invite people from the top of this waitlist into your product."
            }
            action={
              inviteSetup.lock ? (
                <Link href="/admin/products" className={BUTTON}>
                  Go to Products
                </Link>
              ) : (
                <Link href={`${base}/invites`} className={BUTTON}>
                  {funnel && funnel.invited > 0 ? "Open invites" : "Invite your waitlist"}
                </Link>
              )
            }
          />
        ) : null}
      </ul>
      <p className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
        <Mail size={13} aria-hidden /> Open and click rates for every email are on this launch&rsquo;s Analytics tab.
      </p>
    </div>
  );
}
