"use client";

import { useMemo, useState } from "react";
import type { Template } from "@/lib/types/template";
import { SEED_TEMPLATE_GROUPS } from "@/lib/content/templateCategories";
import { TemplateCard } from "./TemplateCard";
import { SpokeList } from "./SpokeList";

/** Templatize tab — modular templates grouped by block, hubs with their channel
 *  spokes nested beneath. */
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
    // Deleting a hub also drops its spokes from the view.
    setTemplates((prev) => prev.filter((x) => x.id !== id && x.parentTemplateId !== id));
  }
  function onDeconstructed(spokes: Template[]) {
    setTemplates((prev) => [...spokes, ...prev]);
  }

  const spokesByParent = useMemo(() => {
    const m = new Map<string, Template[]>();
    for (const t of templates) {
      if (t.tier === "spoke" && t.parentTemplateId) {
        const list = m.get(t.parentTemplateId) ?? [];
        list.push(t);
        m.set(t.parentTemplateId, list);
      }
    }
    return m;
  }, [templates]);

  const byGroup = useMemo(() => {
    const map = new Map<string, Template[]>();
    for (const t of templates) {
      if (t.tier === "spoke") continue; // spokes render nested under their hub
      const g = t.group || "Uncategorised";
      const list = map.get(g) ?? [];
      list.push(t);
      map.set(g, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [templates]);

  // Spokes whose hub isn't present (deleted/flipped) — never let them disappear.
  const orphanSpokes = useMemo(() => {
    const hubIds = new Set(templates.filter((t) => t.tier !== "spoke").map((t) => t.id));
    return templates.filter(
      (t) => t.tier === "spoke" && (!t.parentTemplateId || !hubIds.has(t.parentTemplateId)),
    );
  }, [templates]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-semibold">Templatize</h2>
        <p className="text-sm text-neutral-500">
          Modular templates (with {"{{tokens}}"}) from your Idea Board — tagged by style, block, and
          channel. Reframe, refine, or deconstruct a hub into channel-native spokes.
        </p>
      </div>

      {templates.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No templates yet. Capture an idea in the Idea Board and hit Templatize.
        </p>
      ) : (
        byGroup.map(([group, list]) => (
          <section key={group} className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              {group} <span className="text-neutral-400">({list.length})</span>
            </h3>
            {list.map((t) => (
              <div key={t.id} className="space-y-2">
                <TemplateCard
                  workspaceId={workspaceId}
                  template={t}
                  groups={groups}
                  onUpdate={onUpdate}
                  onDelete={onDelete}
                  onDeconstructed={onDeconstructed}
                />
                <SpokeList
                  workspaceId={workspaceId}
                  spokes={spokesByParent.get(t.id) ?? []}
                  onDelete={onDelete}
                />
              </div>
            ))}
          </section>
        ))
      )}

      {orphanSpokes.length ? (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Ungrouped spokes <span className="text-neutral-400">({orphanSpokes.length})</span>
          </h3>
          <SpokeList workspaceId={workspaceId} spokes={orphanSpokes} onDelete={onDelete} />
        </section>
      ) : null}
    </div>
  );
}
