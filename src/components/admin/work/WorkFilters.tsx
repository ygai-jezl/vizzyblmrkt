"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock } from "lucide-react";
import { COMPANY_STAGES } from "@/lib/work/stages";
import { anyFilter, KIND_CHOICES, STATUS_CHOICES, withFilter } from "@/lib/work/list";
import type { WorkFilters as Filters } from "@/lib/work/inputs";

const SELECT = "rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-950";
const PILL = (on: boolean) =>
  `inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-sm ${
    on ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900" : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
  }`;

/**
 * The list's filters, kept in the address: brand (when the person sees more than one), stage,
 * status, the kind of win, Must have and checks due. Changing one opens the list with it; the
 * server filters and orders (src/lib/work/service.ts listTasks).
 */
export function WorkFilters({ filters, brands, multiBrand, counts }: { filters: Filters; brands: Array<{ id: string; name: string }>; multiBrand: boolean; counts: { mustHave: number; due: number } }) {
  const router = useRouter();
  const go = (patch: Partial<Filters>) => router.push(withFilter(filters, patch));
  return (
    <div role="group" aria-label="Filters" className="flex flex-wrap items-center gap-2">
      {multiBrand ? (
        <label className="flex items-center gap-1.5 text-sm">
          <span className="text-neutral-500 dark:text-neutral-400">Brand</span>
          <select className={SELECT} value={filters.brand ?? ""} onChange={(e) => go({ brand: e.target.value || null })}>
            <option value="">Every brand</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
            <option value="none">Whole business</option>
          </select>
        </label>
      ) : null}
      <label className="flex items-center gap-1.5 text-sm">
        <span className="text-neutral-500 dark:text-neutral-400">Stage</span>
        <select className={SELECT} value={filters.stage ?? ""} onChange={(e) => go({ stage: (e.target.value || null) as Filters["stage"] })}>
          <option value="">Any stage</option>
          {COMPANY_STAGES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.n} {s.label}
            </option>
          ))}
          <option value="none">No stage</option>
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-sm">
        <span className="text-neutral-500 dark:text-neutral-400">Status</span>
        <select className={SELECT} value={filters.status} onChange={(e) => go({ status: e.target.value as Filters["status"] })}>
          {STATUS_CHOICES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-sm">
        <span className="text-neutral-500 dark:text-neutral-400">Kind of win</span>
        <select className={SELECT} value={filters.kind ?? ""} onChange={(e) => go({ kind: (e.target.value || null) as Filters["kind"] })}>
          <option value="">Any kind</option>
          {KIND_CHOICES.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <button type="button" aria-pressed={filters.mustHave} onClick={() => go({ mustHave: !filters.mustHave })} className={PILL(filters.mustHave)}>
        Must have <span className="tabular-nums opacity-70">{counts.mustHave}</span>
      </button>
      <button type="button" aria-pressed={filters.due} onClick={() => go({ due: !filters.due })} className={PILL(filters.due)}>
        <CalendarClock size={14} aria-hidden />
        Checks due <span className="tabular-nums opacity-70">{counts.due}</span>
      </button>
      {anyFilter(filters) ? (
        <Link href="/admin/work" className="text-sm text-neutral-500 underline underline-offset-4 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200">
          Clear filters
        </Link>
      ) : null}
    </div>
  );
}
