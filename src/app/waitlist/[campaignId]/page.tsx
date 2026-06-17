import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { resolveTenantFromOrigin, forTenant } from "@/lib/tenant";
import { originFromHeaders } from "@/lib/http/origin";
import { getLeaderboard } from "@/lib/waitlist/leaderboard";
import { SignupForm } from "@/components/waitlist/SignupForm";
import { StatusCheck } from "@/components/waitlist/StatusCheck";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function HostedWaitlistPage({
  params,
  searchParams,
}: {
  params: Promise<{ campaignId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { campaignId } = await params;
  const sp = await searchParams;
  const referredBySignupToken = typeof sp.ref === "string" ? sp.ref : undefined;
  const justVerified = sp.verified === "1";

  const origin = originFromHeaders(await headers());
  const ctx = await resolveTenantFromOrigin(origin).catch(() => null);
  if (!ctx) notFound();

  const repo = forTenant(ctx);
  const campaign = await repo.campaigns.getById(campaignId);
  if (!campaign) notFound();

  const totalSignups = await repo.signups.count([
    ["campaignId", "==", campaignId],
  ]);
  const leaderboard = await getLeaderboard(ctx, campaign);

  const style = campaign.configurationStyleJson;

  return (
    <main
      className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-8 px-6 py-16"
      style={style.widgetFontColor ? { color: style.widgetFontColor } : undefined}
    >
      {justVerified ? (
        <div className="rounded-md border border-green-300 bg-green-50 px-4 py-3 text-center text-sm text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300">
          ✅ Email confirmed — your spot is locked in!
        </div>
      ) : null}

      <header className="space-y-2 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">
          {campaign.waitlistName}
        </h1>
        {!campaign.hideCounts && totalSignups > 0 ? (
          <p className="text-sm text-neutral-500">
            Join {totalSignups.toLocaleString()} others on the waitlist.
          </p>
        ) : null}
      </header>

      <SignupForm
        campaignId={campaign.id}
        requiredContactDetail={campaign.requiredContactDetail}
        usesFirstnameLastname={campaign.usesFirstnameLastname}
        questions={campaign.questions}
        referredBySignupToken={referredBySignupToken}
        buttonColor={style.widgetButtonColor ?? "#111827"}
        successMessage={style.statusDescription ?? "You're on the list!"}
        joinButtonLabel={style.joinButtonLabel ?? "Join the waitlist"}
        aiConversation={
          campaign.aiConversation?.enabled
            ? { enabled: true, introLine: campaign.aiConversation.introLine }
            : undefined
        }
      />

      <StatusCheck
        campaignId={campaign.id}
        buttonColor={style.widgetButtonColor ?? "#111827"}
      />

      {leaderboard.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-center text-sm font-semibold uppercase tracking-widest text-neutral-500">
            Top referrers
          </h2>
          <ol className="space-y-1">
            {leaderboard.map((entry) => (
              <li
                key={entry.rank}
                className="flex items-center justify-between rounded-md border border-neutral-200 px-4 py-2 text-sm dark:border-neutral-800"
              >
                <span>
                  <span className="mr-2 tabular-nums text-neutral-400">
                    #{entry.rank}
                  </span>
                  {entry.first_name ?? "Someone"} {entry.last_name ?? ""}
                </span>
                <span className="font-medium tabular-nums">
                  {entry.amount_referred} referral
                  {entry.amount_referred === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </main>
  );
}
