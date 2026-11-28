import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { isWorkEnabled, isWorkQuickEditEnabled } from "@/lib/work/flags";
import { refParam } from "@/lib/work/http";
import { listFiltersOf, listScreen, openRow, screenScope } from "@/lib/work/screens";
import { sharedReads } from "@/lib/work/scope";
import { listSubLine, memberBrandNote, regionsDownText, regionsFullText, unreadableText, WORK_COPY } from "@/lib/work/screenWords";
import { EmptyWork } from "@/components/admin/work/EmptyWork";
import { ImportButton } from "@/components/admin/work/ImportDialog";
import { QuickAdd } from "@/components/admin/work/QuickAdd";
import { QuickGuardProvider } from "@/components/admin/work/quickGuard";
import { WorkFilters } from "@/components/admin/work/WorkFilters";
import { WorkQuickTable } from "@/components/admin/work/WorkQuickTable";
import { WorkTable } from "@/components/admin/work/WorkTable";
import { WorkHeader, WorkNote, WorkTabs, WorkUnavailable } from "@/components/admin/work/WorkTabs";
import { filtersHref, queryOf } from "@/lib/work/list";

export const dynamic = "force-dynamic";

/**
 * Work's Tasks tab (WORK_ENABLED): one list of every task the person sees across the organisation's
 * brands and regions, with its filters in the address. Checks due first, then Must have, then the
 * most recently changed. Off, the page isn't there.
 *
 * With quick edit on (WORK_QUICK_EDIT_ENABLED), a task opens in place under its row: `?open=<ref>`
 * is read beside the list, sharing one read of the team's tasks for this page load. Off, the list
 * is exactly as before, `?open` is ignored and nothing more is read.
 */
export default async function WorkPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!isWorkEnabled()) notFound();
  const ctx = await requireAdminContext();
  const gate = await screenScope(ctx);
  if (!gate.ok) return <WorkUnavailable message={gate.message} />;
  const params = queryOf(await searchParams);
  const quick = isWorkQuickEditEnabled();
  const openRef = quick ? refParam(params.get("open") ?? "") : null;
  const deps = quick ? { shared: sharedReads() } : {};
  const [s, open] = await Promise.all([listScreen(gate.scope, params, deps), openRef !== null ? openRow(gate.scope, openRef, listFiltersOf(gate.scope, params), deps) : Promise.resolve(null)]);
  const name = s.view === "brand" ? s.sessionBrand.name : s.name;
  const note = s.view === "brand" ? memberBrandNote(s.sessionBrand.name) : s.member ? WORK_COPY.memberOneBrand : null;
  const quickBrand = s.filters.brand === "none" ? null : (s.filters.brand ?? undefined);
  const page = (
    <div className="mx-auto max-w-6xl space-y-5">
      <WorkHeader
        sub={listSubLine({ name, view: s.view, brandCount: s.brands.length, empty: s.empty, vizzy: s.workVizzy })}
        actions={
          <>
            {s.canImport && !s.empty ? <ImportButton brands={s.brands} wholeBusiness={s.view === "organisation" && !s.oneBrand} /> : null}
            <QuickAdd brandId={quickBrand} />
          </>
        }
      />
      <WorkTabs active="tasks" openCount={s.empty ? null : s.counts.open} />
      {note ? <WorkNote>{note}</WorkNote> : null}
      {s.regionsDown.length ? <WorkNote tone="warn">{regionsDownText(s.regionsDown)}</WorkNote> : null}
      {s.regionsFull.length ? <WorkNote tone="warn">{regionsFullText(s.regionsFull)}</WorkNote> : null}
      {s.unreadable ? <WorkNote tone="warn">{unreadableText(s.unreadable)}</WorkNote> : null}
      {s.empty ? (
        <EmptyWork name={name} multiBrand={s.multiBrand} canImport={s.canImport} workVizzy={s.workVizzy} brands={s.brands} wholeBusiness={s.view === "organisation" && !s.oneBrand} />
      ) : quick ? (
        <WorkQuickTable key={filtersHref(s.filters)} rows={s.rows} multiBrand={s.multiBrand} ideaWords={s.ideaWords} filters={s.filters} brands={s.brands} counts={s.counts} open={open} />
      ) : (
        <>
          <div className="space-y-1.5">
            <WorkFilters filters={s.filters} brands={s.brands} multiBrand={s.multiBrand} counts={s.counts} />
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{WORK_COPY.listOrder}</p>
          </div>
          {s.rows.length ? (
            <WorkTable rows={s.rows} multiBrand={s.multiBrand} ideaWords={s.ideaWords} />
          ) : (
            <p className="rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">{WORK_COPY.noMatch}</p>
          )}
        </>
      )}
      <p className="text-xs text-neutral-500 dark:text-neutral-400">{WORK_COPY.foot}</p>
    </div>
  );
  return quick ? <QuickGuardProvider>{page}</QuickGuardProvider> : page;
}

