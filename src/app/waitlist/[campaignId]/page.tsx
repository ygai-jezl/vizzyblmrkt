import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { resolveTenantFromOrigin, forTenant } from "@/lib/tenant";
import { originFromHeaders } from "@/lib/http/origin";
import { SignupForm } from "@/components/waitlist/SignupForm";

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

  const origin = originFromHeaders(await headers());
  const ctx = await resolveTenantFromOrigin(origin).catch(() => null);
  if (!ctx) notFound();

  const repo = forTenant(ctx);
  const campaign = await repo.campaigns.getById(campaignId);
  if (!campaign) notFound();

  const totalSignups = await repo.signups.count([
    ["campaignId", "==", campaignId],
  ]);

  const style = campaign.configurationStyleJson;

  return (
    <main
      className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-8 px-6 py-16"
      style={style.widgetFontColor ? { color: style.widgetFontColor } : undefined}
    >
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
      />
    </main>
  );
}
