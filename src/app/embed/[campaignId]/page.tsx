import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { resolveTenantFromOrigin, forTenant } from "@/lib/tenant";
import { originFromHeaders } from "@/lib/http/origin";
import { getLeaderboard } from "@/lib/waitlist/leaderboard";
import { SignupForm } from "@/components/waitlist/SignupForm";
import {
  parseWidgetType,
  widgetVariant,
  parseThemeOverrides,
} from "@/lib/widget/types";
import { EmbedAutoResize } from "./EmbedAutoResize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Chrome-free, framable signup widget. Served from our origin and dropped into
 * a customer's site via an iframe (see /embed.js). Resolves tenant + campaign
 * exactly like the hosted page, so the signup API, referral attribution, and
 * reCAPTCHA all work same-origin inside the frame. Frame-ancestors for this
 * route are relaxed in next.config.ts.
 */
export default async function EmbedPage({
  params,
  searchParams,
}: {
  params: Promise<{ campaignId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { campaignId } = await params;
  const sp = await searchParams;
  const get = (k: string): string | undefined =>
    typeof sp[k] === "string" ? (sp[k] as string) : undefined;

  const widgetType = parseWidgetType(get("type"));
  const variant = widgetVariant(widgetType);
  const referredBySignupToken = get("ref");
  const theme = parseThemeOverrides(get);

  const origin = originFromHeaders(await headers());
  const ctx = await resolveTenantFromOrigin(origin).catch(() => null);
  if (!ctx) notFound();

  const repo = forTenant(ctx);
  const campaign = await repo.campaigns.getById(campaignId);
  if (!campaign) notFound();

  const style = campaign.configurationStyleJson;
  const buttonColor = theme.buttonColor ?? style.widgetButtonColor ?? "#111827";
  const fontColor = theme.fontColor ?? style.widgetFontColor;
  const showHeader = !campaign.removeWidgetHeaders;
  const showCount = !campaign.hideCounts;

  const totalSignups = showCount
    ? await repo.signups.count([["campaignId", "==", campaignId]])
    : 0;
  // Only the full widget shows the leaderboard; mini/docked stay compact.
  const leaderboard =
    variant === "full" ? await getLeaderboard(ctx, campaign) : [];

  return (
    <>
      {/* Force a transparent canvas so the widget blends into the host page. */}
      <style>{"html,body{background:transparent!important}body{margin:0}"}</style>
      <EmbedAutoResize background={theme.backgroundColor}>
        <div
          className="mx-auto flex max-w-md flex-col gap-5 px-4 py-4"
          style={fontColor ? { color: fontColor } : undefined}
        >
          {showHeader ? (
            <header className="space-y-1 text-center">
              <h1 className="text-xl font-semibold tracking-tight">
                {campaign.waitlistName}
              </h1>
              {showCount && totalSignups > 0 ? (
                <p className="text-xs text-neutral-500">
                  Join {totalSignups.toLocaleString()} others on the waitlist.
                </p>
              ) : null}
            </header>
          ) : null}

          <SignupForm
            campaignId={campaign.id}
            requiredContactDetail={campaign.requiredContactDetail}
            usesFirstnameLastname={campaign.usesFirstnameLastname}
            questions={campaign.questions}
            referredBySignupToken={referredBySignupToken}
            buttonColor={buttonColor}
            successMessage={style.statusDescription ?? "You're on the list!"}
            variant={variant}
            embedded
          />

          {leaderboard.length > 0 ? (
            <section className="space-y-2">
              <h2 className="text-center text-xs font-semibold uppercase tracking-widest text-neutral-500">
                Top referrers
              </h2>
              <ol className="space-y-1">
                {leaderboard.map((entry) => (
                  <li
                    key={entry.rank}
                    className="flex items-center justify-between rounded-md border border-neutral-200 px-3 py-1.5 text-xs dark:border-neutral-800"
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
        </div>
      </EmbedAutoResize>
    </>
  );
}
