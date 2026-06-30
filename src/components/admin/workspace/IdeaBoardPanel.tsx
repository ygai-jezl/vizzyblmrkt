"use client";

import { useCallback, useEffect, useState } from "react";
import type { IdeaItem } from "@/lib/types/ideaItem";
import type { Template } from "@/lib/types/template";
import { SEED_TEMPLATE_GROUPS } from "@/lib/content/templateCategories";
import { IdeaCaptureBar } from "./IdeaCaptureBar";
import { IdeaCard } from "./IdeaCard";

/** Idea Board — capture + grid of ideas, each one-click templatizable. */
export function IdeaBoardPanel({
  workspaceId,
  initialItems,
}: {
  workspaceId: string;
  initialItems: IdeaItem[];
}) {
  const [items, setItems] = useState<IdeaItem[]>(initialItems);
  const [groups, setGroups] = useState<string[]>(SEED_TEMPLATE_GROUPS);

  // Load the workspace's known structural groups for the combobox.
  const loadGroups = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/workspace/${workspaceId}/templates`);
      if (!res.ok) return;
      const d = (await res.json().catch(() => ({}))) as { groups?: string[] };
      const merged = Array.from(new Set([...(d.groups ?? []), ...SEED_TEMPLATE_GROUPS]));
      setGroups(merged);
    } catch {
      /* keep seeds */
    }
  }, [workspaceId]);

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  function onCaptured(item: IdeaItem) {
    setItems((prev) => [item, ...prev]);
  }
  function onDelete(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }
  function onTemplatized(id: string, template: Template) {
    setItems((prev) =>
      prev.map((i) => (i.id === id ? { ...i, status: "templatized", templateId: template.id } : i)),
    );
    setGroups((prev) => Array.from(new Set([template.group, ...prev])));
  }
  function onGroupCreated(group: string) {
    setGroups((prev) => Array.from(new Set([group, ...prev])));
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Idea Board</h2>
        <p className="text-sm text-neutral-500">
          Your brain dump — drop links, screenshots, or quick text. Hit Templatize to turn one into a
          reusable skeleton.
        </p>
      </div>

      <IdeaCaptureBar workspaceId={workspaceId} onCaptured={onCaptured} />

      {items.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No ideas captured yet. Paste a post you admire, drop a screenshot, or jot a thought above.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <IdeaCard
              key={item.id}
              workspaceId={workspaceId}
              item={item}
              groups={groups}
              onDelete={onDelete}
              onTemplatized={onTemplatized}
              onGroupCreated={onGroupCreated}
            />
          ))}
        </div>
      )}
    </div>
  );
}
