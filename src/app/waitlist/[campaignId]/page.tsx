import { headers, cookies } from "next/headers";
import { notFound } from "next/navigation";
import { resolveTenantForRequest, forTenant, getTenantById } from "@/lib/tenant";
import { originFromHeaders } from "@/lib/http/origin";
import { getLeaderboard } from "@/lib/waitlist/leaderboard";
import { buildSharePayload } from "@/lib/waitlist/postSignup";
import { SignupForm } from "@/components/waitlist/SignupForm";
import { SignupSuccess } from "@/components/waitlist/SignupSuccess";
import { StatusCheck } from "@/components/waitlist/StatusCheck";
import { WaitlistClosed } from "@/components/waitlist/WaitlistClosed";
import { LanguageSwitcher } from "@/components/waitlist/LanguageSwitcher";
import { isClosed } from "@/lib/waitlist/closed";
import { localeInfo, resolveVisitorLocale, supportedLocalesFor } from "@/lib/i18n/locale";
import { getMessage, getWidgetMessages, formatNumber, pluralText } from "@/lib/i18n/messages";

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
  // Set by the double-opt-in confirm redirect: the just-verified signup's
  // (public) referral token, used to render its full post-signup payoff.
  const verifiedReferralToken = typeof sp.rt === "string" ? sp.rt : undefined;
  const tenantId = typeof sp.t === "string" ? sp.t : undefined;

  const hdrs = await headers();
  const origin = originFromHeaders(hdrs);
  const ctx = await resolveTenantForRequest({ tenantId, origin }).catch(() => null);
  if (!ctx) notFound();

  const repo = forTenant(ctx);
  const campaign = await repo.campaigns.getById(campaignId);
  if (!campaign) notFound();

  // Per-visitor content language (see embed page for the resolution chain).
  const tenant = await getTenantById(ctx.tenantId).catch(() => null);
  const cookieLng = (await cookies()).get("lng")?.value;
  const locale = resolveVisitorLocale({
    explicit: (typeof sp.lng === "string" && sp.lng ? sp.lng : undefined) ?? cookieLng,
    acceptLanguage: hdrs.get("accept-language"),
    campaign,
    tenant,
  });
  const messages = getWidgetMessages(locale);
  const dir = localeInfo(locale).dir;
  const supportedLocales = supportedLocalesFor(campaign, tenant);
  const t = (key: string, vars?: Record<string, string | number>) => getMessage(locale, key, vars);

  const totalSignups = await repo.signups.count([
    ["campaignId", "==", campaignId],
  ]);
  const leaderboard = await getLeaderboard(ctx, campaign);

  const style = campaign.configurationStyleJson;
  const buttonColor = style.widgetButtonColor ?? "#111827";
  const aiConversation = campaign.aiConversation?.enabled
    ? { enabled: true, introLine: campaign.aiConversation.introLine }
    : undefined;

  // Just confirmed via the email link? Resolve that signup (equality-only query)
  // and render the same success payoff the signup form shows — referral link,
  // share buttons, position, and the voice CTA — instead of a bare banner.
  let verified: Awaited<ReturnType<typeof buildSharePayload>> & {
    referralToken: string;
  } | null = null;
  if (justVerified && verifiedReferralToken) {
    const [signup] = await repo.signups.find({
      where: [
        ["campaignId", "==", campaignId],
        ["referralToken", "==", verifiedReferralToken],
      ],
      limit: 1,
    });
    if (signup && signup.status === "verified_active") {
      const share = await buildSharePayload(ctx, campaign, signup);
      verified = { ...share, referralToken: signup.referralToken };
    }
  }

  return (
    <main
      className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-8 px-6 py-16"
      lang={locale}
      dir={dir}
      style={style.widgetFontColor ? { color: style.widgetFontColor } : undefined}
    >
      <LanguageSwitcher
        locales={supportedLocales}
        current={locale}
        label={t("widget.common.language")}
      />
      {justVerified ? (
        <div className="rounded-md border border-green-300 bg-green-50 px-4 py-3 text-center text-sm text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300">
          {t("widget.verified.banner")}
        </div>
      ) : null}

      <header className="space-y-2 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">
          {campaign.waitlistName}
        </h1>
        {!campaign.hideCounts && totalSignups > 0 ? (
          <p className="text-sm text-neutral-500">
            {t("widget.header.joinOthers", { count: formatNumber(locale, totalSignups) })}
          </p>
        ) : null}
      </header>

      {verified ? (
        // Post-verification: the confirmed signup gets the full payoff (referral
        // link, share, position, voice) rather than a blank "join" form.
        <SignupSuccess
          campaignId={campaign.id}
          heading={style.statusDescription ?? t("widget.success.onList")}
          hideCounts={verified.hideCounts}
          rank={verified.rank}
          amountReferred={verified.amountReferred}
          referralLink={verified.referralLink}
          referralToken={verified.referralToken}
          shareMessage={verified.shareMessage}
          enabledPlatforms={verified.enabledSharePlatforms}
          buttonColor={buttonColor}
          aiConversation={aiConversation}
          messages={messages}
          locale={locale}
        />
      ) : (
        <>
          {/* Archived launches close the join form but keep the (read-only)
              status check, so existing signups can still look up their spot. */}
          {isClosed(campaign) ? (
            <WaitlistClosed message={t("widget.closed.message")} />
          ) : (
            <SignupForm
              campaignId={campaign.id}
              requiredContactDetail={campaign.requiredContactDetail}
              usesFirstnameLastname={campaign.usesFirstnameLastname}
              questions={campaign.questions}
              referredBySignupToken={referredBySignupToken}
              buttonColor={buttonColor}
              successMessage={style.statusDescription ?? t("widget.success.onList")}
              joinButtonLabel={style.joinButtonLabel ?? t("widget.signup.joinCta")}
              aiConversation={aiConversation}
              messages={messages}
              locale={locale}
            />
          )}

          <StatusCheck
            campaignId={campaign.id}
            buttonColor={buttonColor}
            messages={messages}
            locale={locale}
          />
        </>
      )}

      {leaderboard.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-center text-sm font-semibold uppercase tracking-widest text-neutral-500">
            {t("widget.leaderboard.title")}
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
                  {entry.first_name ?? t("widget.leaderboard.someone")} {entry.last_name ?? ""}
                </span>
                <span className="font-medium tabular-nums">
                  {pluralText(messages, locale, entry.amount_referred, "widget.leaderboard.referrals")}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </main>
  );
}
