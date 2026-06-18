import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { originFromHeaders } from "@/lib/http/origin";
import { platformOrigin } from "@/lib/platform/origin";
import { toCampaignSettings } from "@/lib/admin/campaignSettings";
import { WidgetBuilder } from "@/components/admin/WidgetBuilder";

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
          Style this launch&apos;s waitlist and embed it on any site. Tweak the
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
      />
    </div>
  );
}
