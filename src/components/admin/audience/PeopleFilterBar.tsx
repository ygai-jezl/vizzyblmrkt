"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, X } from "lucide-react";
import type { FilterField, PeopleFilters } from "@/lib/audience/peopleList";
import type { FieldValue } from "@/lib/types/recordField";
import { MANY_LAUNCHES_TAG } from "@/lib/ideas/list";
import { api } from "../connect/api";

/**
 * The People list's filters with AUDIENCE_FIELD_FILTERS_ENABLED: Everyone and Only people we can
 * email, a menu each for launches, products and stages, In more than one launch (with ideas on), and
 * one for each of the brand's select, multi select, status and checkbox fields. Firestore allows one array-contains a query, so one
 * filter applies at a time; a product group comes from "Everyone in this group" on a person's
 * page. A field's counts load when its menu opens.
 */

const STAGES = [
  ["new", "New"],
  ["onboarding", "Onboarding"],
  ["stuck", "Stuck"],
  ["activated", "Activated"],
  ["quiet", "Quiet"],
] as const;

const pill = (active: boolean) =>
  `inline-flex items-center gap-1 rounded-md border px-2.5 py-1 ${
    active
      ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
      : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
  }`;

export interface ActiveGroup {
  tag: string;
  label: string;
}

/** What one filter is called in words: "Plan: Pro", "Stage: Stuck", or null for everyone. */
export function filterLabel(show: string, filters: PeopleFilters, group: ActiveGroup | null): string | null {
  if (show === "all") return null;
  if (group && show === group.tag) return `Group: ${group.label}`;
  if (show === "via:site") return "Launch: From your site";
  if (show === MANY_LAUNCHES_TAG) return "In more than one launch";
  const [kind, a, b] = show.split(":");
  if (kind === "launch") return `Launch: ${filters.launches.find((l) => l.id === a)?.name ?? "A launch"}`;
  if (kind === "product") return `Product: ${filters.products.find((p) => p.id === a)?.name ?? "A product"}`;
  if (kind === "stage" || kind === "quiet") {
    const product = filters.products.find((p) => p.id === a);
    const stage = STAGES.find(([s]) => s === (kind === "quiet" ? "quiet" : b))?.[1] ?? b;
    return `Stage: ${filters.products.length > 1 && product ? `${product.name}, ` : ""}${stage}`;
  }
  if (kind === "field") {
    const f = filters.fields?.find((x) => x.id === a);
    return f ? `${f.label}: ${f.options.find((o) => o.id === b)?.label ?? "An option"}` : null;
  }
  if (kind === "group") return "Group";
  return null;
}

/** A field's value in a list cell: option labels, Yes or No for a box. */
export function cellText(field: FilterField, value: FieldValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (field.type === "checkbox") return value === true ? "Yes" : "No";
  const ids = Array.isArray(value) ? value : [String(value)];
  return ids.map((id) => field.options.find((o) => o.id === id)?.label).filter(Boolean).join(", ") || null;
}

function Menu({ label, active, onClear, onOpen, children }: { label: string; active: string | null; onClear: () => void; onOpen?: () => void; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  if (active) {
    return (
      <button type="button" className={pill(true)} onClick={onClear} aria-label={`${active}, clear this filter`}>
        {active} <X size={12} />
      </button>
    );
  }
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        className={pill(false)}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
        }}
      >
        {label} <ChevronDown size={12} />
      </button>
      {open ? (
        <div role="menu" className="absolute left-0 z-20 mt-1 max-h-72 min-w-48 overflow-y-auto rounded-md border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-950">
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

function Item({ label, count, onPick }: { label: string; count?: number | null; onPick: () => void }) {
  return (
    <button type="button" role="menuitem" onClick={onPick} className="flex w-full items-center justify-between gap-4 rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900">
      <span>{label}</span>
      {count != null ? <span className="tabular-nums text-xs text-neutral-500">{count}</span> : null}
    </button>
  );
}

export function PeopleFilterBar({
  filters,
  show,
  search,
  canEmail,
  group,
  onPick,
  onCanEmail,
}: {
  filters: PeopleFilters;
  show: string;
  search: string;
  canEmail: boolean;
  group: ActiveGroup | null;
  onPick: (tag: string) => void;
  onCanEmail: (on: boolean) => void;
}) {
  const [counts, setCounts] = useState<Record<string, Record<string, number> | "loading">>({});
  const shown = search ? "" : show;
  const [kind, id] = shown.split(":");
  const active = (k: string[]) => (k.includes(kind ?? "") ? filterLabel(shown, filters, group) : null);
  const clear = () => onPick("all");
  const choose = (tag: string, close: () => void) => {
    onPick(tag);
    close();
  };
  const fields = filters.fields ?? [];
  const launches = filters.launches.filter((l) => l.count > 0);
  const products = filters.products.filter((p) => p.count > 0);

  const countField = (fieldId: string) => {
    setCounts((c) => ({ ...c, [fieldId]: "loading" }));
    void api<{ counts: Record<string, number> }>(`/api/admin/audience/list/filters?field=${encodeURIComponent(fieldId)}`).then((r) =>
      setCounts((c) => ({ ...c, [fieldId]: r.ok ? r.data.counts : {} })),
    );
  };

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-xs" role="group" aria-label="Who to show">
        <button type="button" aria-pressed={shown === "all"} className={pill(shown === "all")} onClick={clear}>
          Everyone <span className="tabular-nums opacity-70">{filters.everyone}</span>
        </button>
        <button type="button" aria-pressed={canEmail} disabled={Boolean(search)} className={`${pill(canEmail && !search)} disabled:opacity-50`} onClick={() => onCanEmail(!canEmail)}>
          Only people we can email <span className="tabular-nums opacity-70">{filters.canEmail}</span>
        </button>
        {launches.length || filters.via.site ? (
          <Menu label="Launch" active={active(["launch", "via"])} onClear={clear}>
            {(close) => (
              <>
                {launches.map((l) => (
                  <Item key={l.id} label={l.name} count={l.count} onPick={() => choose(`launch:${l.id}`, close)} />
                ))}
                {filters.via.site ? <Item label="From your site" count={filters.via.site} onPick={() => choose("via:site", close)} /> : null}
              </>
            )}
          </Menu>
        ) : null}
        {filters.manyLaunches ? (
          <button
            type="button"
            aria-pressed={shown === MANY_LAUNCHES_TAG}
            className={pill(shown === MANY_LAUNCHES_TAG)}
            onClick={() => (shown === MANY_LAUNCHES_TAG ? clear() : onPick(MANY_LAUNCHES_TAG))}
          >
            In more than one launch <span className="tabular-nums opacity-70">{filters.manyLaunches}</span>
          </button>
        ) : null}
        {products.length ? (
          <>
            <Menu label="Product" active={active(["product"])} onClear={clear}>
              {(close) => products.map((p) => <Item key={p.id} label={p.name} count={p.count} onPick={() => choose(`product:${p.id}`, close)} />)}
            </Menu>
            <Menu label="Stage" active={active(["stage", "quiet"])} onClear={clear}>
              {(close) =>
                products.flatMap((p) =>
                  STAGES.map(([s, word]) => (
                    <Item
                      key={`${p.id}:${s}`}
                      label={products.length > 1 ? `${p.name}: ${word}` : word}
                      count={p.stages[s]}
                      onPick={() => choose(s === "quiet" ? `quiet:${p.id}` : `stage:${p.id}:${s}`, close)}
                    />
                  )),
                )
              }
            </Menu>
          </>
        ) : null}
        {fields.map((f) => {
          const c = counts[f.id];
          return (
            <Menu key={f.id} label={f.label} active={kind === "field" && id === f.id ? filterLabel(shown, filters, group) : null} onClear={clear} onOpen={() => countField(f.id)}>
              {(close) =>
                f.options.length === 0 ? (
                  <p className="px-2 py-1.5 text-sm text-neutral-500">No options in use.</p>
                ) : (
                  f.options.map((o) => (
                    <Item key={o.id} label={o.label} count={c && c !== "loading" ? (c[o.id] ?? 0) : null} onPick={() => choose(`field:${f.id}:${o.id}`, close)} />
                  ))
                )
              }
            </Menu>
          );
        })}
        {group && shown === group.tag ? (
          <button type="button" className={pill(true)} onClick={clear} aria-label={`Group: ${group.label}, clear this filter`}>
            Group: {group.label} <X size={12} />
          </button>
        ) : null}
      </div>
      {fields.length ? (
        <p className="text-xs text-neutral-500">Your fields: {fields.map((f) => f.label).join(", ")}. Filter by one at a time.</p>
      ) : null}
    </div>
  );
}
