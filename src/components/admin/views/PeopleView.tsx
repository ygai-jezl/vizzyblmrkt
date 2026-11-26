"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowDown, ArrowUp, MoreHorizontal } from "lucide-react";
import { personHref } from "@/lib/audience/paths";
import { FORMER_TEAM_MEMBER } from "@/lib/team/former";
import type { RecordField } from "@/lib/types/recordField";
import type { ViewScope } from "@/lib/types/savedView";
import { columnKind, holdsTypedWords, isSortable, type FilterFlag } from "@/lib/views/conditions";
import { VIEW_LIMITS, type ViewDefinition, type ViewFilter, type ViewMatch, type ViewSort } from "@/lib/views/types";
import { amountWords, columnName, dayWords, VIEW_MESSAGES, viewErrorText, type ViewNames } from "@/lib/views/words";
import { Button, inputClass } from "../connect/ui";
import { CanEmailCell, StageCell, WhereFromCell } from "../audience/PeopleCells";
import { Chip } from "../people/Chip";
import { ago, day } from "../people/format";
import { ColumnPicker, SortMenu } from "./ColumnPicker";
import { draftOf, FilterBuilder, filterOf, type DraftFilter } from "./FilterBuilder";
import { SaveViewDialog } from "./SaveViewDialog";
import { Popover, ViewMenu } from "./ViewMenu";
import { bringBackView, changeView, removeView, runView, saveView, viewRows, type RunAnswer, type ShownView, type ViewLists, type ViewRow } from "./viewsApi";

/**
 * People as a view (CRM_VIEWS_ENABLED): the Views bar (Views, the view's name, Columns, Sort, Save
 * view), the filter builder, the search box inside the view, the count, and the rows, 50 at a time
 * by id. Runs wait 600 ms after a change; changing columns reads the rows shown again instead of
 * running the view. A view with no group of 5,000 or fewer to start from says so.
 */

/** A view as it opens: from the list's group (unsaved), or a saved one. */
export interface OpenView {
  match: ViewMatch;
  filters: ViewFilter[];
  columns: string[];
  sort: ViewSort | null;
  saved: ShownView | null;
  /** What the list was showing when the view began ("from Everyone"). */
  from: string;
  q: string;
  /** Start with an empty filter to fill in (Add filter). */
  addOne?: DraftFilter | null;
}

const RUN_WAIT_MS = 600;
const ROWS_WAIT_MS = 400;

function fieldText(field: RecordField, value: unknown, names: ViewNames): ReactNode {
  if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) return <span className="text-neutral-400">None set</span>;
  switch (field.type) {
    case "number":
      return typeof value === "number" ? value.toLocaleString("en-GB") : null;
    case "currency":
      return typeof value === "number" ? amountWords(value, field.currency) : null;
    case "date":
      return typeof value === "string" ? dayWords(value) : null;
    case "checkbox":
      return value === true ? "Yes" : "No";
    case "select":
    case "status":
    case "multi_select": {
      const ids = Array.isArray(value) ? value : [value];
      return ids.map((id) => field.options?.find((o) => o.id === id)?.label ?? "An option").join(", ");
    }
    case "team_member":
      return names.team?.find((m) => m.id === value)?.name ?? FORMER_TEAM_MEMBER;
    default:
      return <span className="line-clamp-2 max-w-[16rem]">{String(value)}</span>;
  }
}

export function PeopleView({
  open,
  names,
  manyLaunches,
  everyone,
  isAdmin,
  lists,
  multiProduct,
  newPersonButton,
  onOpen,
  onSaved,
  onBringBack,
}: {
  open: OpenView;
  names: ViewNames;
  manyLaunches: boolean;
  everyone: number | null;
  isAdmin: boolean;
  lists: ViewLists | null;
  multiProduct: boolean;
  newPersonButton: ReactNode;
  /** A pick from Views: a saved view, or null for the list itself. */
  onOpen: (view: ShownView | null) => void;
  /** After a save, rename, archive, bring back or delete: the view now open, or null when it was taken away. */
  onSaved: (view: ShownView | null) => void;
  onBringBack: (view: ShownView) => void;
}) {
  const router = useRouter();
  const [match, setMatch] = useState<ViewMatch>(open.match);
  const [drafts, setDrafts] = useState<DraftFilter[]>(() => [...open.filters.map((f) => draftOf(f, names.fields)), ...(open.addOne ? [open.addOne] : [])]);
  const [columns, setColumns] = useState<string[]>(open.columns);
  const [sort, setSort] = useState<ViewSort | null>(open.sort);
  const [q, setQ] = useState(open.q);
  const [saved, setSaved] = useState<ShownView | null>(open.saved);
  const [answer, setAnswer] = useState<RunAnswer | null>(null);
  const [rows, setRows] = useState<ViewRow[] | null>(null);
  const [running, setRunning] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [dialog, setDialog] = useState<null | "save" | "copy" | "rename">(null);
  const [more, setMore] = useState(false);
  /** From the last run, by filter: why one is ignored or narrowed now. */
  const [flags, setFlags] = useState<Record<number, FilterFlag | null>>({});
  const generation = useRef(0);

  const applied = useMemo(() => drafts.flatMap((d) => {
    const f = filterOf(d);
    return f ? [{ id: d.id, f }] : [];
  }), [drafts]);
  const definition: ViewDefinition = useMemo(() => ({ match, filters: applied.map((a) => a.f), columns, sort }), [match, applied, columns, sort]);
  const typed = applied.some((a) => holdsTypedWords(a.f));
  const runKey = JSON.stringify({ match, filters: definition.filters, sort, q: q.trim() });
  const dirty = saved ? JSON.stringify(definition) !== JSON.stringify(saved.definition) : true;
  const canChange = !!saved && !saved.archived && (saved.scope === "me" || isAdmin);

  // Run the view a moment after it changes (at once when it opens).
  const first = useRef(true);
  useEffect(() => {
    const asked = ++generation.current;
    const sent = applied.map((a) => a.id);
    setRunning(true);
    const t = setTimeout(
      () => {
        void runView(definition, q.trim()).then((r) => {
          if (asked !== generation.current) return;
          setRunning(false);
          if (!r.ok) return setProblem(viewErrorText(r.data.error));
          setProblem(null);
          setFlags(Object.fromEntries(sent.map((id, i) => [id, r.data.flags[i] ?? null])));
          setAnswer(r.data);
          setRows(r.data.rows);
        });
      },
      first.current ? 0 : RUN_WAIT_MS,
    );
    first.current = false;
    return () => clearTimeout(t);
    // The run follows what it would show; columns only change the rows (below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey]);

  // Columns changed: read the rows shown again with them, never a new run.
  const shownColumns = useRef(columns);
  useEffect(() => {
    if (JSON.stringify(shownColumns.current) === JSON.stringify(columns) || !answer || !rows) return;
    const asked = generation.current;
    const t = setTimeout(() => {
      void viewRows(answer.ids.slice(0, Math.max(rows.length, VIEW_LIMITS.page)), columns).then((r) => {
        if (asked !== generation.current || !r.ok) return;
        shownColumns.current = columns;
        setRows(r.data.rows);
      });
    }, ROWS_WAIT_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns]);

  async function loadMore() {
    if (!answer || !rows || loadingMore) return;
    const asked = generation.current;
    setLoadingMore(true);
    const r = await viewRows(answer.ids.slice(rows.length, rows.length + VIEW_LIMITS.page), columns);
    if (asked !== generation.current) return;
    setLoadingMore(false);
    if (!r.ok) return setProblem(viewErrorText(r.data.error));
    setRows((cur) => [...(cur ?? []), ...r.data.rows]);
  }

  /** A filter on a field adds the field's column once it is complete, when there is room. */
  function changeDrafts(next: DraftFilter[]) {
    const completeFields = (list: DraftFilter[]) => new Set(list.filter((d) => d.on.startsWith("fld_") && filterOf(d)).map((d) => d.on));
    const before = completeFields(drafts);
    const added = [...completeFields(next)].filter((on) => !before.has(on) && !columns.includes(on));
    if (added.length) setColumns((c) => [...c, ...added].slice(0, VIEW_LIMITS.columns));
    setDrafts(next);
  }

  async function saveNew(name: string, scope: ViewScope): Promise<string | null> {
    const r = await saveView(scope, name, definition);
    if (!r.ok) return viewErrorText(r.data.error);
    setSaved(r.data.view);
    setDialog(null);
    onSaved(r.data.view);
    return null;
  }

  async function saveChanges(change: { name?: string; definition?: ViewDefinition }): Promise<string | null> {
    if (!saved) return VIEW_MESSAGES.failed;
    const r = await changeView(saved.id, saved.version, change);
    if (!r.ok) return viewErrorText(r.data.error);
    setSaved(r.data.view);
    setDialog(null);
    onSaved(r.data.view);
    return null;
  }

  async function takeAway() {
    if (!saved) return;
    setMore(false);
    const r = await removeView(saved.id, saved.version);
    if (!r.ok) return setProblem(viewErrorText(r.data.error));
    // The filters stay open as an unsaved view.
    setSaved(null);
    onSaved(null);
  }

  async function bringBack() {
    if (!saved) return;
    const r = await bringBackView(saved.id, saved.version);
    if (!r.ok) return setProblem(viewErrorText(r.data.error));
    setSaved(r.data.view);
    onSaved(r.data.view);
  }

  const fieldOf = (id: string) => names.fields.find((f) => f.key === id) ?? null;
  const shown = columns.filter((c) => columnKind(c, names.fields) !== null);
  const headerSort = (id: string) => {
    if (!isSortable(columnKind(id, names.fields))) return;
    setSort(sort?.by === id ? { by: id, dir: sort.dir === "desc" ? "asc" : "desc" } : { by: id, dir: "desc" });
  };
  const cell = (id: string, p: ViewRow): ReactNode => {
    switch (id) {
      case "person": {
        const href = personHref(p.id);
        return (
          <>
            <Link href={href} onClick={(e) => e.stopPropagation()} className="block font-medium hover:underline">
              {p.name ?? p.email ?? p.phone ?? "Unnamed person"}
            </Link>
            {p.name && (p.email ?? p.phone) ? <span className="text-xs text-neutral-500">{p.email ?? p.phone}</span> : null}
          </>
        );
      }
      case "where_from":
        return <WhereFromCell p={p} />;
      case "stage":
        return <StageCell p={p} multiProduct={multiProduct} />;
      case "can_email":
        return <CanEmailCell p={p} />;
      case "last_active":
        return p.activeAt ? <span title={day(p.activeAt)} className="text-neutral-500">{ago(p.activeAt)}</span> : null;
      case "first_seen":
        return p.firstSeenAt ? <span className="text-neutral-500">{day(p.firstSeenAt)}</span> : null;
    }
    const field = fieldOf(id);
    return field ? fieldText(field, p.fields?.[id], names) : null;
  };

  const saveButtons = saved?.archived ? (
    isAdmin ? (
      <Button tone="primary" onClick={() => void bringBack()}>
        Bring back
      </Button>
    ) : null
  ) : !saved ? (
    <Button tone="primary" disabled={typed} onClick={() => setDialog("save")}>
      Save view
    </Button>
  ) : canChange ? (
    dirty ? (
      <Button tone="primary" disabled={typed} onClick={() => void saveChanges({ definition }).then((p) => p && setProblem(p))}>
        Save changes
      </Button>
    ) : null
  ) : (
    <Button disabled={typed} onClick={() => setDialog("copy")}>
      Save as my view
    </Button>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ViewMenu lists={lists} everyone={everyone} current={saved?.id ?? "unsaved"} isAdmin={isAdmin} onPick={onOpen} onBringBack={onBringBack} />
        {saved ? (
          <span className="flex items-center gap-2 text-sm">
            <strong>{saved.name}</strong>
            {saved.scope === "team" ? <Chip tone="violet">Team view</Chip> : <Chip tone="neutral">Only me</Chip>}
            {saved.archived ? <Chip tone="amber">Archived</Chip> : null}
            {dirty && !saved.archived ? <span className="text-xs text-neutral-500">Changed, not saved</span> : null}
          </span>
        ) : (
          <span className="text-sm">
            <strong>Unsaved view</strong> <span className="text-neutral-500">from {open.from}</span>
          </span>
        )}
        {canChange ? (
          <Popover label={<span className="sr-only">More for this view</span>} icon={<MoreHorizontal size={14} aria-hidden />} open={more} setOpen={setMore} buttonClass="!px-1.5">
            <button type="button" role="menuitem" className="block w-full rounded px-2 py-1.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900" onClick={() => {
                setMore(false);
                setDialog("rename");
              }}>
              Rename
            </button>
            <button type="button" role="menuitem" disabled={typed} className="block w-full rounded px-2 py-1.5 text-left hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-900" onClick={() => {
                setMore(false);
                setDialog("copy");
              }}>
              Save as a new view
            </button>
            <button type="button" role="menuitem" className="block w-full rounded px-2 py-1.5 text-left text-red-700 hover:bg-neutral-100 dark:text-red-400 dark:hover:bg-neutral-900" onClick={() => void takeAway()}>
              {saved?.scope === "team" ? "Archive this team view" : "Delete this view"}
            </button>
          </Popover>
        ) : null}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <ColumnPicker columns={columns} names={names} onChange={setColumns} />
          <SortMenu sort={sort} columns={columns} names={names} onChange={setSort} />
          {saveButtons}
        </span>
      </div>

      {saved?.archived ? <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">{VIEW_MESSAGES.archived_view}</p> : null}
      {typed ? (
        <p className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <AlertTriangle size={14} aria-hidden /> {VIEW_MESSAGES.typed_words}
        </p>
      ) : null}

      <FilterBuilder match={match} drafts={drafts} flags={flags} names={names} manyLaunches={manyLaunches} onMatch={setMatch} onChange={changeDrafts} />

      {answer?.capped ? (
        <p className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <AlertTriangle size={14} aria-hidden /> {VIEW_MESSAGES.capped}
          {answer.start.kind === "everyone" ? <span className="text-amber-700/80 dark:text-amber-300/80">{answer.total.toLocaleString("en-GB")} people in all.</span> : null}
        </p>
      ) : null}
      {answer?.sortIgnored ? <p className="text-xs text-amber-700 dark:text-amber-400">{VIEW_MESSAGES.sort_ignored}</p> : null}
      {problem ? <p className="text-sm text-red-700 dark:text-red-400">{problem}</p> : null}

      <div className="flex flex-wrap items-center gap-3">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search this view by name, email or domain" aria-label="Search this view" className={`${inputClass} max-w-xs`} />
        <span className="text-sm font-medium">
          {running && !answer ? "Counting…" : answer ? `${answer.count.toLocaleString("en-GB")} ${answer.count === 1 ? "person matches" : "people match"}` : null}
        </span>
        {newPersonButton ? <span className="ml-auto">{newPersonButton}</span> : null}
      </div>

      {!rows ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">Nobody matches this view.</p>
      ) : (
        <div className={`overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800 ${running ? "opacity-70" : ""}`}>
          <table className="w-full min-w-[720px] text-sm">
            <thead className="whitespace-nowrap text-left text-xs text-neutral-500">
              <tr className="border-b border-neutral-200 dark:border-neutral-800">
                {shown.map((id) => {
                  const sortable = isSortable(columnKind(id, names.fields));
                  const on = sort?.by === id;
                  return (
                    <th key={id} className="px-3 py-2 font-medium" aria-sort={on ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}>
                      {sortable ? (
                        <button type="button" onClick={() => headerSort(id)} className={`inline-flex items-center gap-1 hover:underline ${on ? "text-neutral-900 dark:text-neutral-100" : ""}`}>
                          {columnName(id, names)}
                          {on ? sort!.dir === "asc" ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden /> : null}
                        </button>
                      ) : (
                        columnName(id, names)
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-900">
              {rows.map((p) => (
                <tr key={p.id} onClick={() => router.push(personHref(p.id))} className="cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900/50">
                  {shown.map((id) => (
                    <td key={id} className={`px-3 py-2 ${id === "can_email" || id === "last_active" ? "whitespace-nowrap" : ""}`}>
                      {cell(id, p)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows && rows.length > 0 && answer ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500">
          <span>
            {rows.length.toLocaleString("en-GB")} of {answer.count.toLocaleString("en-GB")} {answer.count === 1 ? "person" : "people"}
          </span>
          {rows.length < answer.ids.length ? (
            <Button disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          ) : null}
        </div>
      ) : null}

      {dialog === "save" || dialog === "copy" ? (
        <SaveViewDialog
          title="Save view"
          definition={definition}
          names={names}
          isAdmin={isAdmin}
          initialName={dialog === "copy" && saved ? saved.name : ""}
          initialScope={dialog === "copy" && !isAdmin ? "me" : undefined}
          onCancel={() => setDialog(null)}
          onSave={saveNew}
        />
      ) : dialog === "rename" && saved ? (
        <SaveViewDialog title="Rename view" renaming definition={definition} names={names} isAdmin={isAdmin} initialName={saved.name} onCancel={() => setDialog(null)} onSave={(name) => saveChanges({ name })} />
      ) : null}
    </div>
  );
}
