import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { originFromHeaders } from "@/lib/http/origin";
import { platformOrigin } from "@/lib/platform/origin";
import { toCampaignSettings } from "@/lib/admin/campaignSettings";
import { WidgetBuilder } from "@/components/admin/WidgetBuilder";
import { isSiteSignupsEnabled } from "@/lib/waitlist/siteFlags";
import { isPageLanguagesEnabled } from "@/lib/i18n/flags";
import { launchBaseOf, launchLanguages } from "@/lib/i18n/launchTranslations";
import { localeInfo } from "@/lib/i18n/locale";
import { getTenantById } from "@/lib/tenant";
import type { Campaign } from "@/lib/types/campaign";

/** The launch's own language and its others with widget words, by their own names, for the snippet's picker. */
async function widgetLanguages(tenantId: string, campaign: Campaign): Promise<Array<{ code: string; name: string }>> {
  const tenant = await getTenantById(tenantId).catch(() => null);
  return [launchBaseOf(campaign, tenant), ...launchLanguages(campaign, tenant)].map((code) => ({ code, name: localeInfo(code).nativeName }));
}
import { isIdeaWordsEnabled } from "@/lib/ideas/flags";
import { ideaWord } from "@/lib/nav/terms";

export const dynamic = "force-dynamic";

export default async function LaunchWidgetPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const ctx = await requireAdminContext();
  const { campaignId } = await params;
  const campaign = await forTenant(ctx).campaigns.getById(campaignId);
  if (!campaign) notFound();
  const origin = originFromHeaders(await headers());
  const embedOrigin = platformOrigin() || origin;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Embed &amp; Design</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Style this {ideaWord(isIdeaWordsEnabled()).own} waitlist and embed it on any site. Tweak the
          branding, preview each surface, then copy the snippet.
        </p>
      </div>
      <WidgetBuilder
        origin={origin}
        embedOrigin={embedOrigin}
        tenantId={ctx.tenantId}
        campaigns={[
          {
            id: campaign.id,
            waitlistName: campaign.waitlistName,
            settings: toCampaignSettings(campaign),
          },
        ]}
        initialCampaignId={campaign.id}
        siteForm={isSiteSignupsEnabled() ? { canEdit: ctx.role === "admin" } : undefined}
        languages={isPageLanguagesEnabled() ? await widgetLanguages(ctx.tenantId, campaign) : undefined}
      />
    </div>
  );
}
