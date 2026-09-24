import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { isBrandVoiceEnabled, BRAND_KIT_ROUTE } from "@/lib/content/brandKit";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";
import { BrandVoiceEditor } from "@/components/admin/brand-kit/BrandVoiceEditor";

export const dynamic = "force-dynamic";

/**
 * Brand Kit → Brand voice. Author the tenant-global brand voice (Summary / Do / Don't /
 * guidelines) that grounds all AI-generated copy. Distinct from Account → Brand (the
 * PDF-extracted guidelines kit). Flag-gated by BRAND_VOICE_ENABLED.
 */
export default async function BrandVoicePage() {
  const ctx = await requireAdminContext();
  if (!isBrandVoiceEnabled()) notFound();
  // Nav v2 phase 3: make the precedence visible. A programme's own voice is a
  // fallback — generation uses it only while this brand voice is empty.
  const phase3 = isNavV2Phase3Enabled();
  const withOwnVoice = phase3
    ? (await forTenant(ctx).workspaces.find({ where: [], limit: 200 }).catch(() => [])).filter(
        (w) => !w.archivedAt && w.brandVoice?.trim(),
      )
    : [];

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={BRAND_KIT_ROUTE}
          className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          <ChevronLeft size={14} /> {phase3 ? "Brand" : "Brand Kit"}
        </Link>
        <h1 className="mt-1 text-lg font-semibold">Brand voice</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {phase3
            ? "Describe how your brand writes. One voice per brand — every piece of written copy follows it: content, launch and lifecycle emails, personal AI lines, Vizzy's drafts and the voice assistant."
            : "Describe how your brand writes. One voice per brand — it steers the AI everywhere it drafts copy: content, launch emails, and the voice assistant."}
        </p>
      </div>
      {withOwnVoice.length ? (
        <p className="rounded-md border border-neutral-200 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:text-neutral-300">
          {withOwnVoice.length === 1 ? "One programme has its" : `${withOwnVoice.length} programmes have their`} own voice
          too:{" "}
          {withOwnVoice.map((w, i) => (
            <span key={w.id}>
              {i ? ", " : ""}
              <Link href={`/admin/workspace/${w.id}/settings`} className="font-medium underline underline-offset-2">
                {w.name}
              </Link>
            </span>
          ))}
          . While a brand voice is saved here, it&rsquo;s used instead; a programme&rsquo;s voice only applies when this one is
          empty.
        </p>
      ) : null}
      <BrandVoiceEditor />
    </div>
  );
}
