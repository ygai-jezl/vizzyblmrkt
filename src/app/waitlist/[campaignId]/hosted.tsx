import * as React from "react";
import type { Metadata } from "next";
import { headers, cookies } from "next/headers";
import { notFound, permanentRedirect, redirect } from "next/navigation";
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
import { voiceChatDone } from "@/lib/waitlist/voiceChat";
import { localeInfo, negotiateAcceptLanguage, normalizeLocale, resolveVisitorLocale, supportedLocalesFor } from "@/lib/i18n/locale";
import { isPageLanguagesEnabled } from "@/lib/i18n/flags";
import { approvedLaunchLanguages, approvedLaunchWords, launchBaseOf, launchLanguages } from "@/lib/i18n/launchTranslations";
import { hreflangOf } from "@/lib/content/blog/languageTags";
import type { TenantContext } from "@/lib/tenant/types";
import type { Campaign } from "@/lib/types/campaign";
import { getMessage, getWidgetMessages, formatNumber, pluralText } from "@/lib/i18n/messages";
import { waitlistNameSizeClass, signupCountSizeClass } from "@/lib/widget/textSize";

type Search = Record<string, string | string[] | undefined>;

/**
 * The hosted launch page, for /waitlist/<id> and /waitlist/<id>/<lang>.
 *
 * With PAGE_LANGUAGES_ENABLED, each language has its own address, Google's way: the default page
 * shows the launch's own language, /<lang> one of its other languages (one the widget has words
 * in), with the launch's words as approved in that language, else its own words and noindex.
 * Nothing switches by cookie or browser language; a browser that prefers another offered language
 * sees a link to it. An old ?lng= link goes on to its page with a permanent redirect. Off: one
 * address, the language chosen by ?lng=, the cookie, then the browser, as before.
 */

/** React's per-request memo on the server; a plain call elsewhere (tests). */
const cache: <T extends (...args: never[]) => unknown>(fn: T) => T = (React as { cache?: <T>(fn: T) => T }).cache ?? ((fn) => fn);

/** The brand and the launch, read once per request for both the metadata and the page. */
const loadHosted = cache(async (campaignId: string, tenantParam: string | undefined, origin: string) => {
  const ctx = await resolveTenantForRequest({ tenantId: tenantParam, origin }).catch(() => null);
  if (!ctx) return null;
  const campaign = await forTenant(ctx).campaigns.getById(campaignId);
  if (!campaign) return null;
  const tenant = await getTenantById(ctx.tenantId).catch(() => null);
  const languages = isPageLanguagesEnabled()
    ? { base: launchBaseOf(campaign, tenant), offered: launchLanguages(campaign, tenant), approved: await approvedLaunchLanguages(ctx, campaign, tenant) }
    : null;
  return { ctx, campaign, tenant, languages };
});

/** A language's page path, keeping ?t= on the shared host. */
function pagePath(ctx: TenantContext, campaign: Pick<Campaign, "id">, lang: string | null): string {
  const path = `/waitlist/${encodeURIComponent(campaign.id)}${lang ? `/${lang}` : ""}`;
  return ctx.source === "tenant_param" ? `${path}?t=${encodeURIComponent(ctx.tenantId)}` : path;
}

/** The page's title and, with page languages on, its canonical, language tags and robots. */
export async function hostedMetadata(campaignId: string, sp: Search, pathLang: string | null): Promise<Metadata> {
  if (!isPageLanguagesEnabled()) return {};
  const origin = originFromHeaders(await headers());
  const loaded = await loadHosted(campaignId, typeof sp.t === "string" ? sp.t : undefined, origin);
  if (!loaded?.languages) return {};
  const { ctx, campaign, tenant, languages } = loaded;
  if (pathLang && !languages.offered.includes(pathLang)) return {};
  const words = pathLang ? await approvedLaunchWords(ctx, campaign, tenant, pathLang) : null;
  const url = (lang: string | null) => `${origin}${pagePath(ctx, campaign, lang)}`;
  return {
    title: words?.waitlistName ?? campaign.waitlistName,
    alternates: {
      canonical: url(pathLang),
      languages: {
        [hreflangOf(languages.base)]: url(null),
        ...Object.fromEntries(languages.approved.map((l) => [hreflangOf(l), url(l)])),
        "x-default": url(null),
      },
    },
    // A language whose words aren't approved yet shows the launch's own words: kept out of search.
    ...(pathLang && !words ? { robots: { index: false, follow: true } } : {}),
  };
}

export async function renderHostedPage(campaignId: string, sp: Search, pathLang: string | null) {
  const referredBySignupToken = typeof sp.ref === "string" ? sp.ref : undefined;
  const justVerified = sp.verified === "1";
  // Set by an email voice-chat link ({{voice_chat_link}}): resolve the signup and
  // auto-open the post-signup voice chat modal on the payoff card.
  const autoOpenVoice = sp.voice === "1";
  // Set by the double-opt-in confirm redirect (verified=1) and voice links: the
  // signup's (public) referral token, used to render its full post-signup payoff.
  const verifiedReferralToken = typeof sp.rt === "string" ? sp.rt : undefined;
  const tenantId = typeof sp.t === "string" ? sp.t : undefined;

  const hdrs = await headers();
  const origin = originFromHeaders(hdrs);
  const loaded = await loadHosted(campaignId, tenantId, origin);
  if (!loaded) notFound();
  const { ctx, campaign, tenant, languages } = loaded;
  const repo = forTenant(ctx);
  // A language address only exists with page languages on, and only for an offered language.
  if (pathLang && (!languages || !languages.offered.includes(pathLang))) notFound();

  // An old ?lng= link goes on to that language's own page, keeping everything else it carried.
  if (languages && !pathLang && typeof sp.lng === "string" && sp.lng) {
    const wanted = normalizeLocale(sp.lng);
    const rest = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (k !== "lng" && k !== "t" && typeof v === "string") rest.set(k, v);
    const path = pagePath(ctx, campaign, wanted && languages.offered.includes(wanted) ? wanted : null);
    const query = rest.toString();
    permanentRedirect(query ? `${path}${path.includes("?") ? "&" : "?"}${query}` : path);
  }

  // The page's language: its address's (page languages on), else per visitor (see the embed page).
  const locale = languages
    ? (pathLang ?? languages.base)
    : resolveVisitorLocale({
        explicit: (typeof sp.lng === "string" && sp.lng ? sp.lng : undefined) ?? (await cookies()).get("lng")?.value,
        acceptLanguage: hdrs.get("accept-language"),
        campaign,
        tenant,
      });
  // The launch's own words in this language, once approved; until then its own words.
  const words = languages && pathLang ? await approvedLaunchWords(ctx, campaign, tenant, pathLang) : null;
  const messages = getWidgetMessages(locale);
  const dir = localeInfo(locale).dir;
  const supportedLocales = languages ? [languages.base, ...languages.offered] : supportedLocalesFor(campaign, tenant);
  const links = languages ? Object.fromEntries(supportedLocales.map((l) => [l, pagePath(ctx, campaign, l === languages.base ? null : l)])) : undefined;
  // A browser that prefers another offered language gets a link to it, never a redirect.
  const preferred = languages ? negotiateAcceptLanguage(hdrs.get("accept-language"), supportedLocales) : null;
  const suggestion = preferred && preferred !== locale && links ? { href: links[preferred]!, text: getMessage(preferred, "widget.language.viewIn") } : null;
  const t = (key: string, vars?: Record<string, string | number>) => getMessage(locale, key, vars);

  const totalSignups = await repo.signups.count([
    ["campaignId", "==", campaignId],
  ]);
  const leaderboard = await getLeaderboard(ctx, campaign);

  const style = campaign.configurationStyleJson;
  const buttonColor = style.widgetButtonColor ?? "#111827";
  const aiConversation = campaign.aiConversation?.enabled
    ? { enabled: true, introLine: words?.introLine ?? campaign.aiConversation.introLine }
    : undefined;
  const heading = words?.waitlistName ?? campaign.waitlistName;
  const statusDescription = words?.statusDescription ?? style.statusDescription;
  const joinButtonLabel = words?.joinButtonLabel ?? style.joinButtonLabel;
  const closed = isClosed(campaign);

  // Arrived via the double-opt-in confirm link (verified=1) or an email voice-chat
  // link (voice=1)? Resolve that signup (equality-only query) and render the same
  // success payoff the signup form shows — referral link, share buttons, position,
  // and the voice CTA — instead of a bare banner or the join form.
  let verified: Awaited<ReturnType<typeof buildSharePayload>> & {
    referralToken: string;
    /** Already used their one-shot voice chat — don't auto-open into a dead end. */
    voiceCompleted: boolean;
  } | null = null;
  if (verifiedReferralToken && (justVerified || autoOpenVoice)) {
    const [signup] = await repo.signups.find({
      where: [
        ["campaignId", "==", campaignId],
        ["referralToken", "==", verifiedReferralToken],
      ],
      limit: 1,
    });
    // A person who signed up in another of the page's languages lands on its page.
    const own = languages && signup ? normalizeLocale(signup.locale) : null;
    if (languages && own && own !== locale && languages.offered.concat(languages.base).includes(own)) {
      const path = pagePath(ctx, campaign, own === languages.base ? null : own);
      const rest = new URLSearchParams();
      for (const [k, v] of Object.entries(sp)) if (k !== "t" && typeof v === "string") rest.set(k, v);
      redirect(`${path}${path.includes("?") ? "&" : "?"}${rest.toString()}`);
    }
    if (signup && signup.status === "verified_active") {
      const share = await buildSharePayload(ctx, campaign, signup);
      verified = {
        ...share,
        referralToken: signup.referralToken,
        voiceCompleted: voiceChatDone(signup.aiConversation),
      };
    }
  }
  // Only auto-open the voice modal when it can actually succeed: not on a closed
  // launch (mint 409s) and not for a signup that already used its one-shot chat
  // (mint 409s after the mic prompt). The CTA still renders; it just isn't forced.
  const autoOpenVoiceOk =
    autoOpenVoice && !closed && verified?.voiceCompleted !== true;

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
        {...(links ? { links } : {})}
      />
      {suggestion ? (
        <p className="text-center text-sm" lang={preferred ?? undefined}>
          <a href={suggestion.href} className="underline">
            {suggestion.text}
          </a>
        </p>
      ) : null}
      {justVerified ? (
        <div className="rounded-md border border-green-300 bg-green-50 px-4 py-3 text-center text-sm text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300">
          {t("widget.verified.banner")}
        </div>
      ) : null}

      <header className="space-y-2 text-center">
        <h1
          className={`${waitlistNameSizeClass("hosted", style.waitlistNameSize)} font-semibold tracking-tight`}
        >
          {heading}
        </h1>
        {!campaign.hideCounts && totalSignups > 0 ? (
          <p className={`${signupCountSizeClass("hosted", style.signupCountSize)} text-neutral-500`}>
            {t("widget.header.joinOthers", { count: formatNumber(locale, totalSignups) })}
          </p>
        ) : null}
      </header>

      {verified ? (
        // Post-verification: the confirmed signup gets the full payoff (referral
        // link, share, position, voice) rather than a blank "join" form.
        <SignupSuccess
          campaignId={campaign.id}
          heading={statusDescription ?? t("widget.success.onList")}
          hideCounts={verified.hideCounts}
          rank={verified.rank}
          amountReferred={verified.amountReferred}
          referralLink={verified.referralLink}
          referralToken={verified.referralToken}
          shareMessage={verified.shareMessage}
          enabledPlatforms={verified.enabledSharePlatforms}
          buttonColor={buttonColor}
          aiConversation={aiConversation}
          autoOpenVoice={autoOpenVoiceOk}
          messages={messages}
          locale={locale}
        />
      ) : (
        <>
          {/* Archived launches close the join form but keep the (read-only)
              status check, so existing signups can still look up their spot. */}
          {closed ? (
            <WaitlistClosed message={t("widget.closed.message")} />
          ) : (
            <SignupForm
              campaignId={campaign.id}
              requiredContactDetail={campaign.requiredContactDetail}
              usesFirstnameLastname={campaign.usesFirstnameLastname}
              questions={campaign.questions}
              referredBySignupToken={referredBySignupToken}
              buttonColor={buttonColor}
              successMessage={statusDescription ?? t("widget.success.onList")}
              joinButtonLabel={joinButtonLabel ?? t("widget.signup.joinCta")}
              {...(words ? { questionLabels: words.questions } : {})}
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
