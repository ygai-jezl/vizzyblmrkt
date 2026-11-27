"use client";

import { createContext, useContext, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { BrandMapLeaveGuard } from "./brandMapLeave";

interface TabDef {
  id: string;
  label: string;
}

/** What a view can ask of the page's tabs: show another view, and the buying situation to open there. */
export interface BrandMapTabsApi {
  /** The page has this view. */
  has: (tab: string) => boolean;
  /** Shows a view; with `situation`, Buying situations opens that one when it mounts. */
  show: (tab: string, open?: { situation?: string }) => void;
  /** The situation a link asked to open, if any: read it when the view mounts, then clear it. */
  situation: () => string | null;
  clearSituation: () => void;
}

const BrandMapTabsContext = createContext<BrandMapTabsApi | null>(null);

/** The page's tabs, or null outside them. */
export function useBrandMapTabs(): BrandMapTabsApi | null {
  return useContext(BrandMapTabsContext);
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
  initialTab,
}: {
  editor: ReactNode;
  contentMap: ReactNode | null;
  editorLabel?: string;
  /** More views, between the list and the content map. */
  extra?: Array<TabDef & { node: ReactNode }>;
  /** The view to open first (a link such as Review the strategy names it); the list when it isn't one of them. */
  initialTab?: string;
}) {
  const id = useId();
  const views: Array<TabDef & { node: ReactNode }> = [
    { id: "names", label: editorLabel, node: editor },
    ...extra,
    ...(contentMap ? [{ id: "map", label: "Content map", node: contentMap }] : []),
  ];
  const [tab, setTab] = useState(() => (initialTab && views.some((v) => v.id === initialTab) ? initialTab : "names"));
  const tabs = views.length > 1;
  const viewIds = views.map((v) => v.id).join(" ");
  const situation = useRef<string | null>(null);
  const api = useMemo<BrandMapTabsApi>(() => {
    const ids = viewIds.split(" ");
    return {
      has: (t) => ids.includes(t),
      show: (t, open) => {
        if (!ids.includes(t)) return;
        situation.current = open?.situation ?? null;
        setTab(t);
        document.getElementById(`${id}-${t}-tab`)?.scrollIntoView({ block: "start", behavior: "smooth" });
      },
      situation: () => situation.current,
      clearSituation: () => {
        situation.current = null;
      },
    };
  }, [viewIds, id]);

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const at = views.findIndex((v) => v.id === tab);
    const next = views[(at + (e.key === "ArrowRight" ? 1 : views.length - 1)) % views.length]!.id;
    setTab(next);
    document.getElementById(`${id}-${next}-tab`)?.focus();
  };

  return (
    <BrandMapTabsContext.Provider value={api}>
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
    </BrandMapTabsContext.Provider>
  );
}
