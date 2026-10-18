import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireAdminContext } from "@/lib/auth/session";
import { BRAND_KIT_ROUTE } from "@/lib/content/brandKit";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";
import { isBrandNotesChatEnabled, isBrandNotesEnabled } from "@/lib/brandNotes/flags";
import { listNotes } from "@/lib/brandNotes/store";
import { subjectsForNotes } from "@/lib/brandNotes/subjects";
import type { BrandNote } from "@/lib/types/brandNote";
import { BrandNotesPage } from "@/components/admin/brand-kit/BrandNotesPage";

export const dynamic = "force-dynamic";

/**
 * Brand › What we've seen (BRAND_NOTES_ENABLED): the brand's own first-hand notes, which blog
 * articles draw on when one matches their question strongly. Members can view them; only admins
 * add, change or remove one.
 */
export default async function BrandNotesRoute() {
  const ctx = await requireAdminContext();
  if (!isBrandNotesEnabled()) notFound();
  const [notes, subjects] = await Promise.all([
    listNotes(ctx).catch((err): BrandNote[] => {
      console.error("[brand-notes] read failed", err);
      return [];
    }),
    subjectsForNotes(ctx).catch(() => null),
  ]);

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={BRAND_KIT_ROUTE}
          className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          <ChevronLeft size={14} /> {isNavV2Phase3Enabled() ? "Brand" : "Brand Kit"}
        </Link>
        <h1 className="mt-1 text-lg font-semibold">What we&rsquo;ve seen</h1>
        <p className="max-w-2xl text-sm text-neutral-500 dark:text-neutral-400">
          Your team&rsquo;s first-hand experience: customer stories, things you tested, mistakes you see, what you disagree with.
          Blog articles draw on it when a note fits their question, so they read like they come from people who do the work.
        </p>
      </div>
      <BrandNotesPage initialNotes={notes} subjects={subjects} canEdit={ctx.role === "admin"} chatOn={isBrandNotesChatEnabled()} />
    </div>
  );
}
