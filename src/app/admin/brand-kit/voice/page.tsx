import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireAdminContext } from "@/lib/auth/session";
import { isBrandVoiceEnabled, BRAND_KIT_ROUTE } from "@/lib/content/brandKit";
import { BrandVoiceEditor } from "@/components/admin/brand-kit/BrandVoiceEditor";

export const dynamic = "force-dynamic";

/**
 * Brand Kit → Brand voice. Author the tenant-global brand voice (Summary / Do / Don't /
 * guidelines) that grounds all AI-generated copy. Distinct from Account → Brand (the
 * PDF-extracted guidelines kit). Flag-gated by BRAND_VOICE_ENABLED.
 */
export default async function BrandVoicePage() {
  await requireAdminContext();
  if (!isBrandVoiceEnabled()) notFound();

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={BRAND_KIT_ROUTE}
          className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          <ChevronLeft size={14} /> Brand Kit
        </Link>
        <h1 className="mt-1 text-lg font-semibold">Brand voice</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Describe how your brand writes. One voice per brand — it steers the AI everywhere it
          drafts copy: content, launch emails, and the voice assistant.
        </p>
      </div>
      <BrandVoiceEditor />
    </div>
  );
}
