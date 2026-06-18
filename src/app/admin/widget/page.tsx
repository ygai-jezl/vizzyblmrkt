import { headers } from "next/headers";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { originFromHeaders } from "@/lib/http/origin";
import { platformOrigin } from "@/lib/platform/origin";
import { toCampaignSettings } from "@/lib/admin/campaignSettings";
import { WidgetBuilder } from "@/components/admin/WidgetBuilder";

export const dynamic = "force-dynamic";

export default async function WidgetPage() {
  const ctx = await requireAdminContext();
  const origin = originFromHeaders(await headers());
  const embedOrigin = platformOrigin() || origin;

  const campaigns = await forTenant(ctx).campaigns.find({
    orderBy: [["createdAt", "desc"]],
    limit: 50,
  });

  if (campaigns.length === 0) {
    return <p className="text-sm text-neutral-500">No campaigns yet.</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Widget</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Embed the waitlist on any site. Pick a campaign and widget type, then
          copy the snippet.
        </p>
      </div>
      <WidgetBuilder
        origin={origin}
        embedOrigin={embedOrigin}
        tenantId={ctx.tenantId}
        campaigns={campaigns.map((c) => ({
          id: c.id,
          waitlistName: c.waitlistName,
          settings: toCampaignSettings(c),
        }))}
        initialCampaignId={campaigns[0]!.id}
      />
    </div>
  );
}
