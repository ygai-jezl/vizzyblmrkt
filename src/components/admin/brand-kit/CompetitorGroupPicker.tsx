"use client";

import { useState } from "react";
import { api, errorText } from "@/components/admin/connect/api";
import { COMPETITOR_GROUP_KINDS, COMPETITOR_GROUP_LABEL, NOT_GROUPED_LABEL, type CompetitorGroupKind } from "@/lib/types/brandStrategy";
import type { CompetitorDetail } from "@/lib/competitors/view";

/**
 * The group a watched competitor is in (STRATEGY_COMPETITORS_ENABLED), the same on the Strategy
 * tab, Brand › Competitors and a competitor's page: one list behind two doors. Admins choose it;
 * members read it. Choosing a group never changes the strategy's revision.
 */

const SELECT =
  "rounded border border-neutral-300 bg-white px-1.5 py-0.5 text-[11px] disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950";

export function CompetitorGroupPicker({
  id,
  name,
  group,
  canEdit,
  onSaved,
  onError,
}: {
  id: string;
  name: string;
  group: CompetitorGroupKind | null | undefined;
  canEdit: boolean;
  onSaved: (group: CompetitorGroupKind, competitor: CompetitorDetail | undefined) => void;
  onError: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!canEdit) return <span className="text-[11px] text-neutral-500">{group ? COMPETITOR_GROUP_LABEL[group] : NOT_GROUPED_LABEL}</span>;
  return (
    <select
      aria-label={`Group for ${name}`}
      className={SELECT}
      value={group ?? ""}
      disabled={busy}
      onChange={async (e) => {
        const next = e.target.value as CompetitorGroupKind;
        if (!next || next === group) return;
        setBusy(true);
        const r = await api<{ competitor?: CompetitorDetail; error?: string }>(`/api/admin/brand-kit/competitors/${id}`, { method: "PATCH", body: JSON.stringify({ group: next }) });
        setBusy(false);
        if (r.ok) onSaved(next, r.data.competitor);
        else onError(errorText(r.data));
      }}
    >
      {group ? null : (
        <option value="" disabled>
          Choose a group
        </option>
      )}
      {COMPETITOR_GROUP_KINDS.map((k) => (
        <option key={k} value={k}>
          {COMPETITOR_GROUP_LABEL[k]}
        </option>
      ))}
    </select>
  );
}
