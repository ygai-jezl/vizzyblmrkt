"use client";

import { useMemo, useState } from "react";
import type { BrandMapSuggestion } from "@/lib/types/brandMap";
import { describeChange } from "@/lib/brandMap/changes";
import { Badge, Button } from "@/components/admin/connect/ui";

/**
 * Suggestions waiting for a person. Research comes as one batch — a ticked list, inferred
 * lines unticked — with "Add ticked" and "Dismiss the rest". Suggestions from articles and
 * from Vizzy come one at a time, each with Accept and Dismiss. Accepting puts the change
 * into the form (saved with the map); dismissing happens at once.
 */

const FROM: Record<BrandMapSuggestion["from"], string> = {
  research: "From research",
  article: "From an article",
  vizzy: "From Vizzy",
};

export function BrandMapSuggestions({
  suggestions,
  canEdit,
  busy,
  onAccept,
  onDismiss,
}: {
  suggestions: BrandMapSuggestion[];
  canEdit: boolean;
  busy: boolean;
  onAccept: (rows: BrandMapSuggestion[]) => void;
  onDismiss: (rows: BrandMapSuggestion[]) => void;
}) {
  const research = useMemo(() => suggestions.filter((s) => s.from === "research"), [suggestions]);
  const others = useMemo(() => suggestions.filter((s) => s.from !== "research"), [suggestions]);
  const [unticked, setUnticked] = useState<Set<string>>(() => new Set(research.filter((s) => s.inferred).map((s) => s.key)));
  if (!suggestions.length) return null;

  const ticked = research.filter((s) => !unticked.has(s.key));
  const toggle = (key: string) =>
    setUnticked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <section
      aria-label="Suggestions"
      className="space-y-3 rounded-lg border border-neutral-300 bg-neutral-50 p-4 dark:border-neutral-700 dark:bg-neutral-900"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          Suggestions <span className="ml-1 rounded-full bg-neutral-900 px-2 text-xs font-medium text-white dark:bg-white dark:text-neutral-900">{suggestions.length}</span>
        </h2>
        <p className="text-xs text-neutral-500">Nothing changes until you save.</p>
      </div>

      {research.length ? (
        <div className="space-y-2 rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950">
          <p className="text-sm font-medium">From research</p>
          <ul className="space-y-1.5">
            {research.map((s) => (
              <li key={s.key}>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4"
                    checked={!unticked.has(s.key)}
                    disabled={!canEdit || busy}
                    onChange={() => toggle(s.key)}
                  />
                  <span className="min-w-0">
                    {describeChange(s.change)}
                    {s.inferred ? (
                      <span className="ml-2">
                        <Badge tone="amber">Inferred, check it</Badge>
                      </span>
                    ) : null}
                    {s.reason ? <span className="block text-xs text-neutral-500">{s.reason}</span> : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {canEdit ? (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button tone="primary" disabled={busy || !ticked.length} onClick={() => onAccept(ticked)}>
                Add ticked ({ticked.length})
              </Button>
              <Button disabled={busy || ticked.length === research.length} onClick={() => onDismiss(research.filter((s) => unticked.has(s.key)))}>
                Dismiss the rest
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {others.length ? (
        <ul className="space-y-2">
          {others.map((s) => (
            <li key={s.key} className="space-y-1.5 rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950">
              <p className="text-sm font-medium">{describeChange(s.change)}</p>
              {s.reason || s.ref?.title ? (
                <p className="text-xs text-neutral-500">
                  {s.reason}
                  {s.ref?.title ? `${s.reason ? " · " : ""}“${s.ref.title}”` : ""}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <Badge>{FROM[s.from]}</Badge>
                <span className="flex-1" />
                {canEdit ? (
                  <>
                    <Button disabled={busy} onClick={() => onDismiss([s])}>
                      Dismiss
                    </Button>
                    <Button tone="primary" disabled={busy} onClick={() => onAccept([s])}>
                      Accept
                    </Button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
          {canEdit && others.length > 3 ? (
            <li>
              <Button disabled={busy} onClick={() => onAccept(others)}>
                Accept all ({others.length})
              </Button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </section>
  );
}
