"use client";

import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import type { WorkFilters as Filters } from "@/lib/work/inputs";
import type { WorkRow } from "@/lib/work/list";
import { cellFocus, clickIntent, focusAfterClose, holdOrder, openHref, rowCellOf, wouldMove, type RowCell } from "@/lib/work/quickEdit";
import { deletedLine, WORK_COPY } from "@/lib/work/screenWords";
import type { OpenRow } from "@/lib/work/screens";
import { useBindQuickGuard } from "./quickGuard";
import { missingWords, MissingRowPanel, PendingRowPanel, TaskRowPanel, type FocusWant, type PanelApi } from "./TaskRowPanel";
import { WorkFilters } from "./WorkFilters";
import { rowCols, rowHeads, WorkRowCells } from "./WorkRowCells";

/**
 * Work's list with quick edit (WORK_QUICK_EDIT_ENABLED): click any part of a task's row and it
 * opens right there, full width under the row (TaskRowPanel), with the open task in the address
 * (`?open=<ref>`, changed without scrolling or adding to Back). One row is open at a time.
 * - The order holds for the whole visit: changed rows stay put, new tasks appear on top, and
 *   Sort again shows once anything would move. A filter change or a reload sorts afresh.
 * - A task that stops matching the filters stays until it is closed, with a note; one opened from
 *   elsewhere that isn't in the list shows on top.
 * - Closing, opening another row, a filter and Add task wait for the open row's saves, and ask
 *   about unsaved edits. Focus goes back to the row's Ref button, or the next row's when the task
 *   left the list.
 * - The open row fills the list's visible width, stays in view if the list scrolls sideways, and
 *   lays its sections side by side once the list is 900px wide (measured, as Tailwind here has no
 *   container queries).
 */
export function WorkQuickTable({
  rows,
  multiBrand,
  ideaWords,
  filters,
  brands,
  counts,
  open,
}: {
  rows: WorkRow[];
  multiBrand: boolean;
  ideaWords: boolean;
  filters: Filters;
  brands: Array<{ id: string; name: string }>;
  counts: { mustHave: number; due: number };
  open: OpenRow | null;
}) {
  const router = useRouter();
  const bindGuard = useBindQuickGuard();
  const panelId = "wk-row-panel";
  const [openRef, setOpenRef] = useState<number | null>(open?.ref ?? null);
  const clicks = useRef(1);
  const [want, setWant] = useState<FocusWant | null>(open ? { mark: "heading", n: clicks.current } : null);
  const [focusTo, setFocusTo] = useState<{ ref: number | null; n: number } | null>(null);
  const [live, setLive] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [gone, setGone] = useState<number[]>([]);
  const [, setSorted] = useState(0);
  const held = useRef<string[] | null>(null);
  const table = useRef<HTMLDivElement>(null);
  const panel = useRef<PanelApi | null>(null);
  const lastClosed = useRef<number | null>(null);
  const [width, setWidth] = useState(0);

  // What shows: the server's rows in the order held for this visit, with the open task's row
  // when the filters leave it out, or it is opened from elsewhere.
  const openTask = open?.kind === "task" && open.ref === openRef ? open : null;
  const listed = rows.filter((r) => !gone.includes(r.ref));
  const extra = openTask && !listed.some((r) => r.ref === openTask.ref) ? openTask.row : null;
  const all = extra ? [extra, ...listed] : listed;
  const byId = new Map(all.map((r) => [r.id, r]));
  const order = holdOrder(held.current, all.map((r) => r.id));
  const display = order.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  const serverIds = listed.map((r) => r.id);
  const moved = wouldMove(order, serverIds);
  useEffect(() => {
    held.current = order;
  });
  const latest = useRef({ display, listed, openTask });
  latest.current = { display, listed, openTask };

  // The list's visible width, for the open row.
  useEffect(() => {
    const el = table.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [display.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Run `then` once the open row's saves are in, asking about unsaved edits first. */
  const leave = useCallback((then: () => void) => (panel.current ? panel.current.leave(then) : then()), []);
  const bindPanel = useCallback((api: PanelApi | null) => {
    panel.current = api;
  }, []);

  const openAt = (ref: number, cell: RowCell) => {
    const row = latest.current.display.find((r) => r.ref === ref);
    const f = cellFocus(cell, { multiBrand, due: !!row?.check?.due });
    clicks.current += 1;
    const n = clicks.current;
    if (ref === openRef) return setWant({ ...f, n });
    leave(() => {
      setOpenRef(ref);
      setWant({ ...f, n });
      setLive("");
      setNote(null);
      router.replace(openHref(filters, ref), { scroll: false });
    });
  };

  const closeRow = () => {
    const ref = openRef;
    if (ref === null) return;
    leave(() => {
      const { display: shown, listed: now, openTask: t } = latest.current;
      const before = shown.map((r) => r.ref);
      const leaving = (t?.kept ?? false) || !now.some((r) => r.ref === ref);
      const f = focusAfterClose(before, leaving ? before.filter((r) => r !== ref) : before, ref);
      clicks.current += 1;
      lastClosed.current = f.left ? null : ref;
      setOpenRef(null);
      setWant(null);
      setFocusTo({ ref: f.ref, n: clicks.current });
      setLive(f.left ? WORK_COPY.leftList : "");
      router.replace(openHref(filters, null), { scroll: false });
    });
  };

  const onDeleted = (ref: number, title: string) => {
    const before = latest.current.display.map((r) => r.ref);
    const f = focusAfterClose(before, before.filter((r) => r !== ref), ref);
    clicks.current += 1;
    setGone((g) => [...g, ref]);
    setOpenRef(null);
    setWant(null);
    setNote(deletedLine(ref, title));
    setFocusTo({ ref: f.ref, n: clicks.current });
    router.replace(openHref(filters, null), { scroll: false });
  };

  // Focus back where the row was opened from, once it has closed.
  useEffect(() => {
    if (!focusTo) return;
    const btn = focusTo.ref !== null ? table.current?.querySelector<HTMLElement>(`[data-ref-button="${focusTo.ref}"]`) : null;
    (btn ?? table.current)?.focus({ preventScroll: true });
  }, [focusTo?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  // The row just closed, when it left the list only once the list read itself again, hands focus to the next one.
  const shownKey = display.map((r) => r.ref).join(",");
  const shownBefore = useRef<number[]>(display.map((r) => r.ref));
  useEffect(() => {
    const now = latest.current.display.map((r) => r.ref);
    const was = shownBefore.current;
    shownBefore.current = now;
    const left = lastClosed.current;
    if (left === null || openRef !== null || now.includes(left) || !was.includes(left)) return;
    lastClosed.current = null;
    if (typeof document === "undefined" || (document.activeElement !== document.body && !table.current?.contains(document.activeElement))) return;
    const f = focusAfterClose(was, now, left);
    const btn = f.ref !== null ? table.current?.querySelector<HTMLElement>(`[data-ref-button="${f.ref}"]`) : null;
    (btn ?? table.current)?.focus({ preventScroll: true });
    setLive(WORK_COPY.leftList);
  }, [shownKey, openRef]);

  // The filters and Add task, outside the list, wait for the open row too.
  useEffect(() => {
    bindGuard?.({ leave, open: (ref) => openAt(ref, "title") });
  });
  useEffect(() => () => bindGuard?.(null), [bindGuard]);

  const onRowClick = (e: MouseEvent<HTMLDivElement>, r: WorkRow) => {
    const target = e.target as HTMLElement;
    const wait = target.closest<HTMLElement>("[data-wait]");
    const title = target.closest("[data-title-link]");
    const intent = clickIntent(e, typeof window === "undefined" ? "" : (window.getSelection()?.toString() ?? ""), !!(wait || title));
    if (intent === "page") return;
    if (wait || title) e.preventDefault();
    if (intent === "ignore") return;
    if (wait) return openAt(Number(wait.dataset.wait), "title");
    if (target.closest("[data-ref-button]")) return r.ref === openRef ? closeRow() : openAt(r.ref, "ref");
    openAt(r.ref, rowCellOf(target.closest<HTMLElement>("[data-cell]")?.dataset.cell));
  };
  const onOpenLineKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    closeRow();
  };

  const cols = rowCols(multiBrand, true);
  const heads = rowHeads(multiBrand, ideaWords);
  const goto = (ref: number) => openAt(ref, "title");
  const openLine = (children: JSX.Element) => (
    <div role="row" className={`grid ${cols} border-b border-neutral-200 last:border-b-0 dark:border-neutral-800`}>
      <div role="cell" aria-colspan={heads.length} className="col-span-full min-w-0">
        <div className="sticky left-0" style={width ? { width } : undefined}>
          {children}
        </div>
      </div>
    </div>
  );
  const panelFor = (r: WorkRow) =>
    openTask && openTask.ref === r.ref ? (
      <TaskRowPanel key={r.ref} screen={openTask.screen} kept={openTask.kept} panelId={panelId} width={width} want={want} onClose={closeRow} onGoto={goto} onDeleted={onDeleted} bind={bindPanel} />
    ) : (
      <PendingRowPanel row={r} panelId={panelId} onClose={closeRow} focus={want !== null} />
    );
  // A task opened from elsewhere with no row here yet: on top, on its way or saying why it can't open.
  const topOnly =
    openRef !== null && !display.some((r) => r.ref === openRef)
      ? open && open.ref === openRef && open.kind !== "task"
        ? openLine(<MissingRowPanel message={missingWords(open.kind, open.kind === "unread" ? open.regions : [])} panelId={panelId} onClose={closeRow} />)
        : openLine(<PendingRowPanel row={null} taskRef={openRef} panelId={panelId} onClose={closeRow} focus={want !== null} />)
      : null;

  return (
    <>
      <div className="space-y-1.5">
        <WorkFilters filters={filters} brands={brands} multiBrand={multiBrand} counts={counts} />
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-neutral-500 dark:text-neutral-400">
          <span>{WORK_COPY.listOrder}</span>
          {moved ? (
            <button
              type="button"
              onClick={() => {
                held.current = null;
                setSorted((n) => n + 1);
              }}
              className="font-medium text-neutral-700 underline underline-offset-4 dark:text-neutral-200"
            >
              {WORK_COPY.sortAgain}
            </button>
          ) : null}
        </p>
      </div>
      {note ? (
        <p role="status" className="text-sm text-neutral-600 dark:text-neutral-300">
          {note}
        </p>
      ) : null}
      {display.length || topOnly ? (
        <div ref={table} role="table" aria-label="Tasks" tabIndex={-1} className="overflow-x-auto rounded-md border border-neutral-200 text-sm outline-none dark:border-neutral-800">
          <div role="row" className={`grid ${cols} gap-3 border-b border-neutral-200 bg-neutral-50 px-3 py-2 text-xs font-medium text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400`}>
            {heads.map((h) => (
              <span key={h} role="columnheader">
                {h}
              </span>
            ))}
          </div>
          {topOnly}
          {display.map((r) => {
            const isOpen = r.ref === openRef;
            return (
              <Fragment key={r.id}>
                <div
                  role="row"
                  data-row={r.ref}
                  onClick={(e) => onRowClick(e, r)}
                  onKeyDown={isOpen ? onOpenLineKey : undefined}
                  className={`grid ${cols} cursor-pointer items-start gap-3 border-b border-neutral-100 px-3 py-2.5 last:border-b-0 dark:border-neutral-900 ${
                    isOpen ? "bg-neutral-50 dark:bg-neutral-900/60" : "hover:bg-neutral-50 dark:hover:bg-neutral-900/50"
                  } ${r.closed ? "text-neutral-500 dark:text-neutral-400" : ""}`}
                >
                  <WorkRowCells row={r} multiBrand={multiBrand} ideaWords={ideaWords} quick={{ open: isOpen, panelId }} />
                </div>
                {isOpen ? openLine(panelFor(r)) : null}
              </Fragment>
            );
          })}
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">{WORK_COPY.noMatch}</p>
      )}
      <p className="sr-only" aria-live="polite">
        {live}
      </p>
    </>
  );
}
