"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, UserPlus } from "lucide-react";
import { personHref } from "@/lib/audience/paths";
import type { PeopleFilters, PeopleRow } from "@/lib/audience/peopleList";
import type { NewPersonVia } from "@/lib/audience/newPerson";
import { parseFieldTag } from "@/lib/audience/fieldTags";
import { MANY_LAUNCHES_TAG } from "@/lib/ideas/list";
import { ideaWord } from "@/lib/nav/terms";
import type { FieldValue, RecordField } from "@/lib/types/recordField";
import { filtersFromGroup } from "@/lib/views/conditions";
import { DEFAULT_COLUMNS, isBuiltInFilter, VIEW_LIMITS } from "@/lib/views/types";
import { VIEW_MESSAGES, viewErrorText, type ViewNames } from "@/lib/views/words";
import { api } from "../connect/api";
import { inputClass } from "../connect/ui";
import { CanEmailCell, StageCell, WhereFromCell } from "./PeopleCells";
import { ago, day } from "../people/format";
import { cellText, filterLabel, PeopleFilterBar, type ActiveGroup } from "./PeopleFilterBar";
import { NewPersonDialog } from "./NewPersonDialog";
import { useWords } from "../nav/WordsProvider";
import { loadFieldLists, type Team } from "./fieldsApi";
import { blankDraft } from "../views/FilterBuilder";
import { PeopleView, type OpenView } from "../views/PeopleView";
import { ViewMenu } from "../views/ViewMenu";
import { bringBackView, listViews, type ShownView, type ViewLists } from "../views/viewsApi";

/**
 * Audience → People (AUDIENCE_ONE_VIEW_ENABLED): one row per person, whatever brought
 * them: a launch's form, the brand's own site, a connected product, or several. Shows
 * one group at a time, built from the brand's own launches and products; picking a
 * product shows its stages. Every row opens the person. With AUDIENCE_ADD_PERSON_ENABLED an admin
 * can add someone by hand (New person), here or from ⌘K (`?new=person`). With the words on
 * (useWords().ideas) a launch is an idea. With CRM_VIEWS_ENABLED (`views`) the Views menu opens saved
 * views, and Add filter turns the list into a view starting from the group it shows (PeopleView);
 * a saved view has its own link, `?view=viw_...`.
 */

/** Keep the open saved view in the address bar (?view=), so it has a link and Back returns to it. */
function setViewParam(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("view", id);
  else url.searchParams.delete("view");
  window.history.replaceState(null, "", url);
}

const STAGE_LABEL = { new: "New", onboarding: "Onboarding", stuck: "Stuck", activated: "Activated" } as const;

/** The list's address for a group (or a search), and a page after the first. */
function listUrl(f: { show: string; canEmail: boolean; search: string }, next: string | null): string {
  const p = new URLSearchParams();
  if (f.search) p.set("q", f.search);
  else {
    p.set("show", f.show);
    if (f.canEmail) p.set("email", "1");
  }
  if (next) p.set("cursor", next);
  return `/api/admin/audience/list?${p.toString()}`;
}

const pill = (active: boolean) =>
  `rounded-md border px-2.5 py-1 ${
    active
      ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
      : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
  }`;

export function AudienceList({
  initialQuery = "",
  initialLaunch = null,
  fieldFilters = false,
  initialGroup = null,
  canAddPerson = false,
  fields = false,
  newPerson = false,
  newPersonDraft = null,
  views = null,
}: {
  /** A search the page arrived with (?q=, from ⌘K). */
  initialQuery?: string;
  /** A launch the page arrived with (?launch=, from a launch's Signups page). */
  initialLaunch?: { id: string } | null;
  /** AUDIENCE_FIELD_FILTERS_ENABLED: a menu per filter and per field, and product groups. */
  fieldFilters?: boolean;
  /** A product group the page arrived with (?group=, from "Everyone in this group" on a person's page). */
  initialGroup?: ActiveGroup | null;
  /** An admin with New person on (AUDIENCE_ADD_PERSON_ENABLED): the New person button. */
  canAddPerson?: boolean;
  /** Fields are on (AUDIENCE_FIELDS_ENABLED): New person offers the brand's fields. */
  fields?: boolean;
  /** The page arrived from ⌘K's New person (?new=person): open the form. */
  newPerson?: boolean;
  /** The page arrived from a form Vizzy filled in (?draft=, AUDIENCE_VIZZY_ADD_PERSON_ENABLED): open it filled in. */
  newPersonDraft?: string | null;
  /** Views on People (CRM_VIEWS_ENABLED): whether they are on, the member's role, and a view the page arrived with (?view=). */
  views?: { isAdmin: boolean; initialViewId: string | null } | null;
}) {
  const router = useRouter();
  const { ideas } = useWords();
  const w = ideaWord(ideas);
  const [filters, setFilters] = useState<PeopleFilters | null>(null);
  /** The group shown: a memberOf tag. Within a product, `product` is that product's id. */
  const [show, setShow] = useState(initialGroup ? initialGroup.tag : initialLaunch ? `launch:${initialLaunch.id}` : "all");
  const [product, setProduct] = useState<string | null>(null);
  const [canEmail, setCanEmail] = useState(false);
  const [q, setQ] = useState(initialQuery);
  const [search, setSearch] = useState(initialQuery.trim());
  /** Bumped whenever the group or search changes, so a page still loading for the old one is dropped. */
  const generation = useRef(0);
  const [rows, setRows] = useState<PeopleRow[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  /** With views: every People field (archived ones too), the team, the saved views, and the view open now. */
  const [viewFields, setViewFields] = useState<RecordField[] | null>(null);
  const [team, setTeam] = useState<Team>([]);
  const [lists, setLists] = useState<ViewLists | null>(null);
  const [openView, setOpenView] = useState<(OpenView & { nonce: number }) | null>(null);
  const [viewNotice, setViewNotice] = useState<string | null>(null);
  const opened = useRef(0);
  /** New person is open, and from where. */
  const [adding, setAdding] = useState<NewPersonVia | null>(canAddPerson && newPersonDraft ? "vizzy" : canAddPerson && newPerson ? "palette" : null);

  // ⌘K's New person, or a form Vizzy filled in, while the list is already open.
  useEffect(() => {
    if (canAddPerson && newPersonDraft) setAdding("vizzy");
    else if (canAddPerson && newPerson) setAdding("palette");
  }, [canAddPerson, newPerson, newPersonDraft]);

  const closeNewPerson = () => {
    // Drop ?new=person or ?draft=, so ⌘K or the card can open the form again.
    if (adding === "palette" || adding === "vizzy") router.replace("/admin/crm");
    setAdding(null);
  };

  useEffect(() => {
    void api<PeopleFilters>("/api/admin/audience/list/filters").then((r) => (r.ok ? setFilters(r.data) : setError(true)));
  }, []);

  const reloadViews = () => listViews().then((r) => (r.ok ? setLists(r.data) : null));
  useEffect(() => {
    if (!views) return;
    void loadFieldLists().then((r) => {
      setViewFields(r.ok ? r.data.lists.person.items : []);
      if (r.ok) setTeam(r.data.team);
    });
    void reloadViews();
    // Once, when the list opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [views !== null]);

  const openSaved = (v: ShownView) => {
    setViewNotice(null);
    setOpenView({ match: v.definition.match, filters: v.definition.filters, columns: v.definition.columns, sort: v.definition.sort, saved: v, from: "Everyone", q: "", nonce: ++opened.current });
    setViewParam(v.id);
  };
  const closeView = () => {
    setOpenView(null);
    setViewParam(null);
  };

  // A saved view's link (?view=): open it once the saved views are in.
  const linked = useRef(false);
  useEffect(() => {
    if (!views?.initialViewId || !lists || linked.current) return;
    linked.current = true;
    const v = [...lists.team, ...lists.mine, ...lists.archived].find((x) => x.id === views.initialViewId);
    if (v) openSaved(v);
    else {
      setViewNotice(VIEW_MESSAGES.view_not_found);
      setViewParam(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lists]);

  const bringBack = async (v: ShownView) => {
    const r = await bringBackView(v.id, v.version);
    if (!r.ok) return setViewNotice(viewErrorText(r.data.error));
    await reloadViews();
    openSaved(r.data.view);
  };

  // A pause after typing before searching, so each key doesn't start a query.
  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    let alive = true;
    generation.current += 1;
    setRows(null);
    setLoadingMore(false);
    void api<{ people: PeopleRow[]; nextCursor: string | null; total: number | null }>(listUrl({ show, canEmail, search }, null)).then((r) => {
      if (!alive) return;
      if (!r.ok) return setError(true);
      setRows(r.data.people);
      setTotal(r.data.total);
      setCursor(r.data.nextCursor);
    });
    return () => {
      alive = false;
    };
  }, [show, canEmail, search]);

  async function more() {
    if (!cursor || loadingMore) return;
    const asked = generation.current;
    setLoadingMore(true);
    const r = await api<{ people: PeopleRow[]; nextCursor: string | null }>(listUrl({ show, canEmail, search }, cursor));
    if (asked !== generation.current) return;
    setLoadingMore(false);
    // A page that didn't load leaves the rows already shown; the button stays to try again.
    if (!r.ok) return;
    setRows((cur) => [...(cur ?? []), ...r.data.people]);
    setCursor(r.data.nextCursor);
  }

  const pick = (tag: string, inProduct: string | null = null) => {
    setShow(tag);
    setProduct(inProduct);
    setQ("");
    setSearch("");
  };

  // Filtered by a field value: New person starts with it filled in.
  const filtered = !search ? parseFieldTag(show) : null;
  const filteredField = filtered ? filters?.fields?.find((f) => f.id === filtered.fieldId) : null;
  const prefill: Record<string, FieldValue> =
    filtered && filteredField
      ? { [filtered.fieldId]: filteredField.type === "checkbox" ? true : filteredField.type === "multi_select" ? [filtered.value] : filtered.value }
      : {};
  const newPersonDialog = adding ? (
    <NewPersonDialog
      key={adding === "vizzy" ? `draft-${newPersonDraft}` : adding}
      via={adding}
      fields={fields}
      prefill={adding === "vizzy" ? {} : prefill}
      draftId={adding === "vizzy" ? newPersonDraft : null}
      onClose={closeNewPerson}
    />
  ) : null;
  const newPersonButton = canAddPerson ? (
    <button
      type="button"
      onClick={() => setAdding("form")}
      className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
    >
      <UserPlus size={14} aria-hidden /> New person
    </button>
  ) : null;

  if (error) return <p className="text-sm text-red-700 dark:text-red-400">Couldn&rsquo;t load the list. Reload the page to try again.</p>;
  if (filters && filters.everyone === 0) {
    return (
      <div className="space-y-3 rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
        <p>
          Nobody yet. People appear here when they sign up to {ideas ? "an" : "a"}{" "}
          <Link href="/admin/launches" className="underline underline-offset-2">
            {w.one}
          </Link>{" "}
          or a{" "}
          <Link href="/admin/products" className="underline underline-offset-2">
            connected product
          </Link>{" "}
          sends them{canAddPerson ? ", or when your team adds them by hand." : "."}
        </p>
        {newPersonButton}
        {newPersonDialog}
      </div>
    );
  }

  const viewNames: ViewNames | null =
    views && viewFields && filters
      ? { fields: viewFields, launches: filters.launches, products: filters.products, team, group: initialGroup, groups: lists?.groups ?? [], ideas }
      : null;
  const multiProductList = (filters?.products.length ?? 0) > 1;

  if (views && openView && viewNames) {
    return (
      <>
        {newPersonDialog}
        <PeopleView
          key={openView.nonce}
          open={openView}
          names={viewNames}
          manyLaunches={filters?.manyLaunches !== undefined}
          everyone={filters?.everyone ?? null}
          isAdmin={views.isAdmin}
          lists={lists}
          multiProduct={multiProductList}
          newPersonButton={newPersonButton}
          onOpen={(v) => (v ? openSaved(v) : closeView())}
          onSaved={(v) => {
            void reloadViews();
            setViewParam(v ? v.id : null);
          }}
          onBringBack={(v) => void bringBack(v)}
        />
      </>
    );
  }

  /** Add filter: the list becomes a view, starting from the group it shows and Only people we can email. */
  const addFilter = () => {
    if (!viewNames) return;
    const tag = search ? "all" : show;
    const start = filtersFromGroup(tag, canEmail && !search);
    const fieldColumns = start.map((f) => f.on).filter((on) => !isBuiltInFilter(on));
    setViewNotice(null);
    setOpenView({
      match: "all",
      filters: start,
      columns: [...new Set([...DEFAULT_COLUMNS, ...fieldColumns])].slice(0, VIEW_LIMITS.columns),
      sort: null,
      saved: null,
      from: (filters && !search ? filterLabel(show, filters, initialGroup, ideas) : null) ?? "Everyone",
      q: search,
      // A filter with nothing picked yet: the view counts the same as the list until one is.
      addOne: blankDraft(),
      nonce: ++opened.current,
    });
  };

  const inProduct = product ? filters?.products.find((p) => p.id === product) : null;
  const multiProduct = (filters?.products.length ?? 0) > 1;
  // With field filters: the active field's column first, then the next, at most two.
  const activeField = !search && show.startsWith("field:") ? show.split(":")[1] : null;
  const fieldColumns = fieldFilters
    ? [...(filters?.fields ?? [])].sort((a, b) => Number(b.id === activeField) - Number(a.id === activeField)).slice(0, 2)
    : [];
  const shownLabel = fieldFilters && filters && !search ? filterLabel(show, filters, initialGroup, ideas) : null;

  return (
    <div className="space-y-3">
      {views ? (
        <div className="flex flex-wrap items-center gap-2">
          <ViewMenu lists={lists} everyone={filters?.everyone ?? null} current={null} isAdmin={views.isAdmin} onPick={(v) => (v ? openSaved(v) : undefined)} onBringBack={(v) => void bringBack(v)} />
          <button
            type="button"
            disabled={!viewNames}
            onClick={addFilter}
            className="inline-flex items-center gap-1 rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            <Plus size={14} aria-hidden /> Add filter
          </button>
          {viewNotice ? <span className="text-sm text-red-700 dark:text-red-400">{viewNotice}</span> : null}
        </div>
      ) : null}
      {fieldFilters && filters ? (
        <PeopleFilterBar filters={filters} show={show} search={search} canEmail={canEmail} group={initialGroup} onPick={(tag) => pick(tag)} onCanEmail={setCanEmail} />
      ) : filters ? (
        <div className="flex flex-wrap gap-1.5 text-xs" role="group" aria-label="Who to show">
          <button type="button" aria-pressed={show === "all"} className={pill(show === "all" && !search)} onClick={() => pick("all")}>
            Everyone <span className="tabular-nums opacity-70">{filters.everyone}</span>
          </button>
          {filters.launches
            .filter((l) => l.count > 0)
            .map((l) => (
              <button key={l.id} type="button" aria-pressed={show === `launch:${l.id}`} className={pill(show === `launch:${l.id}` && !search)} onClick={() => pick(`launch:${l.id}`)}>
                {l.name} <span className="tabular-nums opacity-70">{l.count}</span>
              </button>
            ))}
          {filters.manyLaunches ? (
            <button
              type="button"
              aria-pressed={show === MANY_LAUNCHES_TAG}
              className={pill(show === MANY_LAUNCHES_TAG && !search)}
              onClick={() => pick(MANY_LAUNCHES_TAG)}
            >
              In more than one {w.one} <span className="tabular-nums opacity-70">{filters.manyLaunches}</span>
            </button>
          ) : null}
          {filters.via.site > 0 ? (
            <button type="button" aria-pressed={show === "via:site"} className={pill(show === "via:site" && !search)} onClick={() => pick("via:site")}>
              From your site <span className="tabular-nums opacity-70">{filters.via.site}</span>
            </button>
          ) : null}
          {filters.products
            .filter((p) => p.count > 0)
            .map((p) => (
              <button key={p.id} type="button" aria-pressed={product === p.id} className={pill(product === p.id && !search)} onClick={() => pick(`product:${p.id}`, p.id)}>
                {p.name} <span className="tabular-nums opacity-70">{p.count}</span>
              </button>
            ))}
        </div>
      ) : null}

      {inProduct && !fieldFilters ? (
        <div className="flex flex-wrap gap-1.5 text-xs" role="group" aria-label={`Stages in ${inProduct.name}`}>
          <button type="button" className={pill(show === `product:${inProduct.id}`)} onClick={() => pick(`product:${inProduct.id}`, inProduct.id)}>
            All in {inProduct.name}
          </button>
          {(["new", "onboarding", "stuck", "activated"] as const).map((s) => (
            <button key={s} type="button" className={pill(show === `stage:${inProduct.id}:${s}`)} onClick={() => pick(`stage:${inProduct.id}:${s}`, inProduct.id)}>
              {STAGE_LABEL[s]} <span className="tabular-nums opacity-70">{inProduct.stages[s]}</span>
            </button>
          ))}
          <button type="button" className={pill(show === `quiet:${inProduct.id}`)} onClick={() => pick(`quiet:${inProduct.id}`, inProduct.id)}>
            Quiet <span className="tabular-nums opacity-70">{inProduct.stages.quiet}</span>
          </button>
        </div>
      ) : null}

      {newPersonDialog}
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search everyone by name, email or domain"
          aria-label="Search people"
          className={`${inputClass} max-w-xs`}
        />
        {fieldFilters ? null : (
          <label className={`flex items-center gap-1.5 text-sm ${search ? "opacity-50" : ""}`}>
            <input type="checkbox" checked={canEmail} disabled={Boolean(search)} onChange={(e) => setCanEmail(e.target.checked)} />
            Only people we can email
            {filters ? <span className="tabular-nums text-neutral-500">({filters.canEmail} in all)</span> : null}
          </label>
        )}
        {newPersonButton ? <span className="ml-auto">{newPersonButton}</span> : null}
      </div>

      {shownLabel && rows && total !== null ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {total} {total === 1 ? "person" : "people"} {show === MANY_LAUNCHES_TAG ? `in more than one ${w.one}` : `with ${shownLabel}`}
          {canEmail ? ", only people we can email" : ""}
        </p>
      ) : null}

      {!rows ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          {search ? `Nobody matches “${search}”.` : "Nobody in this group yet."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="whitespace-nowrap text-left text-xs text-neutral-500">
              <tr className="border-b border-neutral-200 dark:border-neutral-800">
                <th className="px-3 py-2 font-medium">Person</th>
                <th className="px-3 py-2 font-medium">Where from</th>
                <th className="px-3 py-2 font-medium">Stage</th>
                {fieldColumns.map((f) => (
                  <th key={f.id} className="px-3 py-2 font-medium">
                    {f.label}
                  </th>
                ))}
                <th className="px-3 py-2 font-medium">Can email</th>
                <th className="px-3 py-2 font-medium">Last active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-900">
              {rows.map((p) => {
                const href = personHref(p.id);
                return (
                  <tr key={p.id} onClick={() => router.push(href)} className="cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900/50">
                    <td className="px-3 py-2">
                      <Link href={href} onClick={(e) => e.stopPropagation()} className="block font-medium hover:underline">
                        {p.name ?? p.email ?? p.phone ?? "Unnamed person"}
                      </Link>
                      {p.name && (p.email ?? p.phone) ? <span className="text-xs text-neutral-500">{p.email ?? p.phone}</span> : null}
                    </td>
                    <td className="px-3 py-2">
                      <WhereFromCell p={p} />
                    </td>
                    <td className="px-3 py-2">
                      <StageCell p={p} multiProduct={multiProduct} />
                    </td>
                    {fieldColumns.map((f) => (
                      <td key={f.id} className="px-3 py-2">
                        {cellText(f, p.fields?.[f.id]) ?? <span className="text-neutral-400">None set</span>}
                      </td>
                    ))}
                    <td className="whitespace-nowrap px-3 py-2">
                      <CanEmailCell p={p} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-neutral-500">
                      {p.activeAt ? <span title={day(p.activeAt)}>{ago(p.activeAt)}</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {rows && rows.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500">
          <span>
            {rows.length} of {total ?? rows.length} {total === 1 ? "person" : "people"}
            {search ? ", searching everyone" : ""}
          </span>
          {cursor ? (
            <button
              type="button"
              disabled={loadingMore}
              onClick={() => void more()}
              className="rounded-md border border-neutral-300 px-3 py-1 text-sm text-neutral-800 hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          ) : null}
        </div>
      ) : null}

      {fieldFilters ? (
        <p className="text-xs text-neutral-500">
          Filtering by a product group starts from a person&rsquo;s page: open someone, then <strong>Everyone in this group</strong>.
        </p>
      ) : null}
    </div>
  );
}
