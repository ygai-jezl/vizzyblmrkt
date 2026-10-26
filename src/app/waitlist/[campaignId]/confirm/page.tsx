import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { forTenant, getTenantById, resolveTenantForRequest } from "@/lib/tenant";
import { originFromHeaders } from "@/lib/http/origin";
import { appendTenantParam } from "@/lib/http/tenantParam";
import { localeInfo, resolveVisitorLocale } from "@/lib/i18n/locale";
import { getMessage } from "@/lib/i18n/messages";
import { resolveProductName } from "@/lib/types/campaign";
import { isSiteSignupsEnabled } from "@/lib/waitlist/siteFlags";
import { peekSiteConfirm, type SiteConfirmState } from "@/lib/waitlist/siteSignup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A confirmation link carries a token: never index it, never pass it on as a referrer.
export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };

const str = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : undefined);

/**
 * Confirm subscription, for a site sign-up (LAUNCH_SITE_SIGNUPS_ENABLED). Opening the
 * link from the confirmation email changes nothing: only pressing the button
 * confirms, so a mail scanner that opens links can't confirm for someone. The
 * button posts the token to /api/waitlist/{id}/confirm, which comes back here with
 * the result (or goes to the brand's thank-you page).
 */
export default async function SiteConfirmPage({
  params,
  searchParams,
}: {
  params: Promise<{ campaignId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { campaignId } = await params;
  const sp = await searchParams;
  const tenantId = str(sp.t);
  const token = str(sp.token);
  // Switched off: links already sent confirm the way confirmation links always have.
  if (!isSiteSignupsEnabled()) {
    if (!token) notFound();
    redirect(appendTenantParam(`/api/waitlist/${encodeURIComponent(campaignId)}/verify?token=${encodeURIComponent(token)}`, tenantId));
  }

  const ctx = await resolveTenantForRequest({ tenantId, origin: originFromHeaders(await headers()) }).catch(() => null);
  if (!ctx) notFound();
  const campaign = await forTenant(ctx).campaigns.getById(campaignId);
  if (!campaign) notFound();
  const tenant = await getTenantById(ctx.tenantId).catch(() => null);

  const asked = str(sp.state);
  const view: SiteConfirmState =
    asked === "done"
      ? { state: "done", locale: str(sp.lng) ?? null }
      : asked === "invalid" || asked === "blocked"
        ? { state: asked }
        : await peekSiteConfirm(ctx, campaignId, token ?? "");

  const locale = resolveVisitorLocale({
    explicit: ("locale" in view ? view.locale : null) ?? str(sp.lng),
    campaign,
    tenant,
  });
  const t = (key: string, vars?: Record<string, string | number>) => getMessage(locale, key, vars);
  const name = resolveProductName(campaign);
  const brand = tenant?.tenantName?.trim() || name;
  const buttonColor = campaign.configurationStyleJson?.widgetButtonColor ?? "#111827";

  const title =
    view.state === "ready"
      ? t("siteConfirm.title")
      : view.state === "done"
        ? t("siteConfirm.doneTitle")
        : view.state === "blocked"
          ? t("siteConfirm.blockedTitle")
          : t("siteConfirm.invalidTitle");
  const lead =
    view.state === "ready"
      ? t("siteConfirm.lead", { name })
      : view.state === "done"
        ? t("siteConfirm.doneLead", { name })
        : view.state === "blocked"
          ? t("siteConfirm.blockedLead")
          : t("siteConfirm.invalidLead");

  return (
    <main
      className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6 py-16 text-center"
      lang={locale}
      dir={localeInfo(locale).dir}
    >
      <p className="text-sm font-medium text-neutral-500">{name}</p>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-neutral-600 dark:text-neutral-300">{lead}</p>
      {view.state === "ready" ? (
        <form
          method="post"
          action={appendTenantParam(`/api/waitlist/${encodeURIComponent(campaignId)}/confirm`, tenantId)}
          className="flex flex-col items-center gap-4"
        >
          <input type="hidden" name="token" value={token ?? ""} />
          {view.backAgain ? (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              {t("siteConfirm.backAgain", { brand })}
            </p>
          ) : null}
          <button
            type="submit"
            className="rounded-md px-5 py-2.5 text-sm font-semibold text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
            style={{ backgroundColor: buttonColor }}
          >
            {t("siteConfirm.button")}
          </button>
        </form>
      ) : null}
    </main>
  );
}
