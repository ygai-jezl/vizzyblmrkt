"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Curate sub-tab strip: Idea Board (brain-dump) + Grounding (vector RAG sources). */
export function CurateSubTabs({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const base = `/admin/workspace/${workspaceId}/curate`;
  const tabs = [
    { href: `${base}/idea-board`, label: "Idea Board" },
    { href: `${base}/grounding`, label: "Grounding" },
  ];
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {tabs.map((t) => {
        const active = pathname?.startsWith(t.href) ?? false;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`rounded-full border px-3 py-1 ${
              active
                ? "border-violet-500 bg-violet-50 text-violet-700 dark:border-violet-500 dark:bg-violet-950/40 dark:text-violet-300"
                : "border-neutral-300 text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
