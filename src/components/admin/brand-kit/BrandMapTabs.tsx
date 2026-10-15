"use client";

import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { BrandMapLeaveGuard } from "./brandMapLeave";

interface TabDef {
  id: string;
  label: string;
}

/**
 * The Brand map page's views. The first (the list a person edits) stays mounted while
 * another is shown, so an unsaved edit survives a look elsewhere; the others are drawn only
 * while open. The list sits in the same place with or without the tabs, so the first save
 * (which brings them) never remounts it. With the map at any size there are more views
 * (Subjects, and later Buying situations) between the list and the content map.
 */
export function BrandMapTabs({
  editor,
  contentMap,
  editorLabel = "Names and subjects",
  extra = [],
}: {
  editor: ReactNode;
  contentMap: ReactNode | null;
  editorLabel?: string;
  /** More views, between the list and the content map. */
  extra?: Array<TabDef & { node: ReactNode }>;
}) {
  const id = useId();
  const [tab, setTab] = useState("names");
  const views: Array<TabDef & { node: ReactNode }> = [
    { id: "names", label: editorLabel, node: editor },
    ...extra,
    ...(contentMap ? [{ id: "map", label: "Content map", node: contentMap }] : []),
  ];
  const tabs = views.length > 1;

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const at = views.findIndex((v) => v.id === tab);
    const next = views[(at + (e.key === "ArrowRight" ? 1 : views.length - 1)) % views.length]!.id;
    setTab(next);
    document.getElementById(`${id}-${next}-tab`)?.focus();
  };

  return (
    <BrandMapLeaveGuard>
      <div className="space-y-4">
        {tabs ? (
          <div role="tablist" aria-label="Brand map views" className="flex flex-wrap gap-1 border-b border-neutral-200 dark:border-neutral-800">
            {views.map((t) => (
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
        ) : null}
        <div
          id={`${id}-names`}
          role={tabs ? "tabpanel" : undefined}
          aria-labelledby={tabs ? `${id}-names-tab` : undefined}
          hidden={tabs && tab !== "names"}
        >
          {editor}
        </div>
        {views.slice(1).map((v) =>
          tab === v.id ? (
            <div key={v.id} id={`${id}-${v.id}`} role="tabpanel" aria-labelledby={`${id}-${v.id}-tab`}>
              {v.node}
            </div>
          ) : null,
        )}
      </div>
    </BrandMapLeaveGuard>
  );
}
