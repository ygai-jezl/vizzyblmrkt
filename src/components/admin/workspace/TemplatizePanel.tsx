"use client";

import { useMemo, useState } from "react";
import type { Template } from "@/lib/types/template";
import { SEED_TEMPLATE_GROUPS } from "@/lib/content/templateCategories";
import { TemplateCard } from "./TemplateCard";

/** Templatize tab — reusable templates produced from the Idea Board, grouped by block. */
export function TemplatizePanel({
  workspaceId,
  initialTemplates,
  initialGroups,
}: {
  workspaceId: string;
  initialTemplates: Template[];
  initialGroups: string[];
}) {
  const [templates, setTemplates] = useState<Template[]>(initialTemplates);
  const [groups, setGroups] = useState<string[]>(
    Array.from(new Set([...initialGroups, ...SEED_TEMPLATE_GROUPS])),
  );

  function onUpdate(t: Template) {
    setTemplates((prev) => prev.map((x) => (x.id === t.id ? t : x)));
    setGroups((prev) => Array.from(new Set([t.group, ...prev])));
  }
  function onDelete(id: string) {
    setTemplates((prev) => prev.filter((x) => x.id !== id));
  }

  const byGroup = useMemo(() => {
    const map = new Map<string, Template[]>();
    for (const t of templates) {
      const g = t.group || "Uncategorised";
      const list = map.get(g) ?? [];
      list.push(t);
      map.set(g, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [templates]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-semibold">Templatize</h2>
        <p className="text-sm text-neutral-500">
          Reusable skeletons (with {"{{tokens}}"}) from your Idea Board — grouped by structural block,
          tagged by intent. Edit, re-group, or refine.
        </p>
      </div>

      {templates.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No templates yet. Capture an idea in the Idea Board and hit Templatize.
        </p>
      ) : (
        byGroup.map(([group, list]) => (
          <section key={group} className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              {group} <span className="text-neutral-400">({list.length})</span>
            </h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((t) => (
                <TemplateCard
                  key={t.id}
                  workspaceId={workspaceId}
                  template={t}
                  groups={groups}
                  onUpdate={onUpdate}
                  onDelete={onDelete}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
