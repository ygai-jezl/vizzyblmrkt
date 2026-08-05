import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireAdminContext } from "@/lib/auth/session";
import { isContentSteeringEnabled, BRAND_KIT_ROUTE } from "@/lib/content/brandKit";
import { getSteeringState, type ChannelSteeringState } from "@/lib/distribute/feedback/steeringState";
import { ContentSteering } from "@/components/admin/brand-kit/ContentSteering";

export const dynamic = "force-dynamic";

/**
 * Brand Kit → Content Steering. The transparent view of how the Distribute performance loop is
 * steering AI-written posts: the learned per-channel directive + the DO/AVOID moves + a version
 * timeline where each version shows the AI judge's rationale and the evidence behind it, with a
 * point-in-time REVERT so an operator can course-correct. Flag-gated (CONTENT_STEERING_ENABLED).
 */
export default async function ContentSteeringPage() {
  const ctx = await requireAdminContext();
  if (!isContentSteeringEnabled()) notFound();

  let channels: ChannelSteeringState[] = [];
  try {
    channels = await getSteeringState(ctx);
  } catch (err) {
    console.error("[content-steering] failed to load (index building?)", err);
  }

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={BRAND_KIT_ROUTE}
          className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          <ChevronLeft size={14} /> Brand Kit
        </Link>
        <h1 className="mt-1 text-lg font-semibold">Content Steering</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          How your post performance is teaching the AI what works. Each channel below shows the
          current learned guidance, why it changed, and the proven posts behind it — and lets you
          roll back to any earlier version.
        </p>
      </div>
      <ContentSteering initialChannels={channels} />
    </div>
  );
}
