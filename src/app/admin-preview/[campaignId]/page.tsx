import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { getLeaderboard } from "@/lib/waitlist/leaderboard";
import { SignupForm } from "@/components/waitlist/SignupForm";
import { SignupSuccess } from "@/components/waitlist/SignupSuccess";
import { StatusCheck } from "@/components/waitlist/StatusCheck";
import {
  parseWidgetMode,
  widgetVariant,
  parseThemeOverrides,
} from "@/lib/widget/types";
import { parsePreviewSurface } from "@/lib/widget/preview";
import {
  DEFAULT_SHARE_MESSAGE,
  parseEnabledPlatforms,
  renderSampleShareMessage,
} from "@/lib/waitlist/socialPlatforms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin-only live preview for the Embed & Design builder. Mirrors the public
 * embed (src/app/embed/[campaignId]) and hosted (src/app/waitlist/[campaignId])
 * layouts, but applies the founder's UNSAVED branding draft from query params on
 * top of the persisted campaign config — so every tweak shows instantly without
 * a save. Because the route requires an admin session and is only same-origin
 * framable (frame-ancestors 'self' in next.config.ts), it can accept free-text
 * copy overrides that must never be settable on the public /embed route.
 *
 * It lives at the top level (NOT under /admin/launches/...) on purpose: the
 * builder iframes it, and being outside the admin route tree keeps it clear of
 * the admin sidebar + launch-tab layouts, so the frame renders only the hosted
 * page (Hosted surface) or the bare widget (Full/Mini/Docked).
 */
export default async function LaunchPreviewPage({
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

  const ctx = await requireAdminContext();
  const repo = forTenant(ctx);
  const campaign = await repo.campaigns.getById(campaignId);
  if (!campaign) notFound();

  const surface = parsePreviewSurface(get("surface"));
  const isHosted = surface === "hosted";
  const variant = surface === "hosted" ? "full" : widgetVariant(surface);
  const mode = parseWidgetMode(get("mode"));
  // Preview-only "post-signup" screen — the signup form's success state shown on
  // its own so a founder can style the payoff. Not a public mode (see preview.ts).
  const previewSuccess = get("preview") === "success" && !isHosted;
  const theme = parseThemeOverrides(get);

  const style = campaign.configurationStyleJson;
  const buttonColor = theme.buttonColor ?? style.widgetButtonColor ?? "#111827";
  const fontColor = theme.fontColor ?? style.widgetFontColor;
  const background = theme.backgroundColor;
  const successMessage = get("success") ?? style.statusDescription ?? "You're on the list!";
  const joinButtonLabel = get("joinLabel") ?? style.joinButtonLabel ?? "Join the waitlist";
  // header=0 → remove; header=1 → keep; absent → persisted value. The hosted
  // page always shows its header, so the toggle only applies to widget surfaces.
  const headerParam = get("header");
  const removeHeaders =
    headerParam === "0" ? true : headerParam === "1" ? false : campaign.removeWidgetHeaders;
  const showHeader = isHosted ? true : !removeHeaders;
  const showCount = !campaign.hideCounts;

  // Post-signup payoff inputs. Share platforms + message come from the saved
  // campaign (edited on the Social tab); colours + success copy reflect the live
  // Design draft above. The voice CTA appears only when the campaign enables it.
  const enabledPlatforms = previewSuccess
    ? parseEnabledPlatforms(style.enabledSharePlatforms)
    : [];
  const sampleShareMessage = previewSuccess
    ? renderSampleShareMessage(
        style.shareMessage || DEFAULT_SHARE_MESSAGE,
        campaign.waitlistName,
      )
    : "";
  const aiConversation = campaign.aiConversation?.enabled
    ? { enabled: true, introLine: campaign.aiConversation.introLine }
    : undefined;

  const totalSignups = showCount
    ? await repo.signups.count([["campaignId", "==", campaignId]])
    : 0;
  const leaderboard =
    mode !== "CHECK" && variant === "full" ? await getLeaderboard(ctx, campaign) : [];

  return (
    <>
      <style>{"html,body{background:transparent!important}body{margin:0}"}</style>
      <div
        className={
          isHosted
            ? "mx-auto flex max-w-lg flex-col gap-8 px-6 py-10"
            : "mx-auto flex max-w-md flex-col gap-5 px-4 py-4"
        }
        style={{
          ...(background ? { background } : {}),
          ...(fontColor ? { color: fontColor } : {}),
        }}
      >
        {showHeader ? (
          <header className={isHosted ? "space-y-2 text-center" : "space-y-1 text-center"}>
            <h1
              className={
                isHosted
                  ? "text-3xl font-semibold tracking-tight"
                  : "text-xl font-semibold tracking-tight"
              }
            >
              {campaign.waitlistName}
            </h1>
            {showCount && totalSignups > 0 ? (
              <p className={isHosted ? "text-sm text-neutral-500" : "text-xs text-neutral-500"}>
                Join {totalSignups.toLocaleString()} others on the waitlist.
              </p>
            ) : null}
          </header>
        ) : null}

        {isHosted ? (
          <>
            <SignupForm
              campaignId={campaign.id}
              requiredContactDetail={campaign.requiredContactDetail}
              usesFirstnameLastname={campaign.usesFirstnameLastname}
              questions={campaign.questions}
              buttonColor={buttonColor}
              successMessage={successMessage}
              joinButtonLabel={joinButtonLabel}
            />
            <StatusCheck campaignId={campaign.id} buttonColor={buttonColor} />
          </>
        ) : previewSuccess ? (
          // The post-signup payoff a visitor sees after joining, with sample
          // position/referral data so the founder can style it in place.
          <SignupSuccess
            campaignId={campaign.id}
            heading={successMessage}
            totalSignups={totalSignups}
            hideCounts={campaign.hideCounts}
            rank={42}
            amountReferred={3}
            referralLink="https://example.com/waitlist?ref=DEMO1234"
            referralToken="PREVIEW"
            shareMessage={sampleShareMessage}
            enabledPlatforms={enabledPlatforms}
            buttonColor={buttonColor}
            aiConversation={aiConversation}
          />
        ) : mode === "CHECK" ? (
          <StatusCheck campaignId={campaign.id} buttonColor={buttonColor} defaultOpen />
        ) : (
          <SignupForm
            campaignId={campaign.id}
            requiredContactDetail={campaign.requiredContactDetail}
            usesFirstnameLastname={campaign.usesFirstnameLastname}
            questions={campaign.questions}
            buttonColor={buttonColor}
            successMessage={successMessage}
            joinButtonLabel={joinButtonLabel}
            variant={variant}
            embedded
          />
        )}

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
                    <span className="mr-2 tabular-nums text-neutral-400">#{entry.rank}</span>
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
    </>
  );
}
