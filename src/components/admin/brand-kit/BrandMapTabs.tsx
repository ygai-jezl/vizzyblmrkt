"use client";

import { useId, useState, type KeyboardEvent, type ReactNode } from "react";

type Tab = "names" | "map";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "names", label: "Names and subjects" },
  { id: "map", label: "Content map" },
];

/**
 * The Brand map page's two views. The list stays mounted while the map is shown, so an
 * unsaved edit survives a look at the map; the map is drawn only while it is open.
 */
export function BrandMapTabs({ editor, contentMap }: { editor: ReactNode; contentMap: ReactNode | null }) {
  const id = useId();
  const [tab, setTab] = useState<Tab>("names");
  if (!contentMap) return <>{editor}</>;

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = tab === "names" ? "map" : "names";
    setTab(next);
    document.getElementById(`${id}-${next}-tab`)?.focus();
  };

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Brand map views" className="flex gap-1 border-b border-neutral-200 dark:border-neutral-800">
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`${id}-${t.id}-tab`}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`${id}-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={onKey}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              tab === t.id
                ? "border-neutral-900 text-neutral-900 dark:border-white dark:text-white"
                : "border-transparent text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div id={`${id}-names`} role="tabpanel" aria-labelledby={`${id}-names-tab`} hidden={tab !== "names"}>
        {editor}
      </div>
      {tab === "map" ? (
        <div id={`${id}-map`} role="tabpanel" aria-labelledby={`${id}-map-tab`}>
          {contentMap}
        </div>
      ) : null}
    </div>
  );
}
