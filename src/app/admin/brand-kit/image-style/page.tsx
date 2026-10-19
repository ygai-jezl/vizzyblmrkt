import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireAdminContext } from "@/lib/auth/session";
import { getTenantById } from "@/lib/tenant";
import { BRAND_KIT_ROUTE } from "@/lib/content/brandKit";
import { isBrandImageStyleEnabled } from "@/lib/content/imageStyle/flags";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";
import { ImageStyleCard, type PendingImageStyleSuggestion } from "@/components/admin/brand-kit/ImageStyleCard";

export const dynamic = "force-dynamic";

/**
 * Brand › Image style (BRAND_IMAGE_STYLE_ENABLED): the look every new image starts from. Members
 * can view, including a pending Vizzy suggestion; only admins save or dismiss it.
 */
export default async function ImageStylePage() {
  const ctx = await requireAdminContext();
  if (!isBrandImageStyleEnabled()) notFound();

  const tenant = await getTenantById(ctx.tenantId);
  const suggestion = tenant?.imageStyleSuggestion;
  const pending: PendingImageStyleSuggestion | null = suggestion
    ? {
        defaultStyleId: suggestion.defaultStyleId,
        ...(suggestion.channels ? { channels: suggestion.channels } : {}),
        reason: suggestion.reason,
        suggestedAt: suggestion.suggestedAt,
      }
    : null;
  // The brand's own colours, for the accent choice (valid 6-digit hex only, no repeats).
  const palette = [
    ...new Set(
      (tenant?.brandKit?.palette ?? [])
        .map((c) => c.hex.trim().toLowerCase())
        .filter((hex) => /^#[0-9a-f]{6}$/.test(hex)),
    ),
  ].slice(0, 10);

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={BRAND_KIT_ROUTE}
          className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          <ChevronLeft size={14} /> {isNavV2Phase3Enabled() ? "Brand" : "Brand Kit"}
        </Link>
        <h1 className="mt-1 text-lg font-semibold">Image style</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          The look every new image starts from: social posts, blog heroes, eBook and email images.
        </p>
      </div>
      <ImageStyleCard
        initial={tenant?.imageStyle ?? null}
        suggestion={pending}
        palette={palette}
        canEdit={ctx.role === "admin"}
      />
    </div>
  );
}
