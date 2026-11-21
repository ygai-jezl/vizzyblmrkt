"use client";

import { useCallback, useEffect, useState } from "react";
import type { FieldListChange } from "@/lib/audience/fieldList";
import type { ReadOnlyFieldDef } from "@/lib/audience/readOnlyFields";
import {
  CURRENCY_CODE,
  FIELD_LIMITS,
  FIELD_TYPE_LABEL,
  FIELD_TYPES,
  canVizzyReadText,
  hasOptions,
  isFilterType,
  vizzyReadsField,
  type FieldType,
  type RecordField,
  type RecordFieldObject,
} from "@/lib/types/recordField";
import { Banner, Button, inputClass } from "../connect/ui";
import { ago, day } from "../people/format";
import { changeFieldList, fieldErrorText, loadFieldHistory, loadFieldLists, VIZZY_READS_HINT, type FieldVersionRow, type StoredFieldList } from "./fieldsApi";

/**
 * Settings › Data model (AUDIENCE_FIELDS_ENABLED): the fields on People and on Companies. Your
 * own fields (admins add, rename, change options, archive, restore and change a type; members
 * read), the fields from elsewhere, read only, an archived list, and every change. Restoring an
 * older list comes with settings history (piece O). While Vizzy's text fields are on
 * (AUDIENCE_VIZZY_TEXT_FIELDS_ENABLED), a "Vizzy reads" column, and "Vizzy can read this field" on
 * a People text field for admins.
 */

const OBJECT_WORD: Record<RecordFieldObject, { tab: string; each: string }> = {
  person: { tab: "People", each: "person" },
  company: { tab: "Companies", each: "company" },
};

const chip = (on: boolean) =>
  `rounded-md border px-2 py-1 text-left text-xs ${
    on ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900" : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
  }`;
const typeTag = "rounded border border-neutral-200 px-1.5 py-0.5 text-xs text-neutral-600 dark:border-neutral-800 dark:text-neutral-400";

function versionText(v: FieldVersionRow): string {
  return v.message || v.items.map((i) => `${i.change[0]!.toUpperCase()}${i.change.slice(1)} ‘${i.label}’`).join(", ") || `Version ${v.rev}`;
}

export function DataModel({
  canEdit,
  readOnly,
  filters = false,
  vizzyText = false,
}: {
  canEdit: boolean;
  /** The fields from elsewhere, worked out on the server. */
  readOnly: Record<RecordFieldObject, ReadOnlyFieldDef[]>;
  /** People can be filtered by fields (AUDIENCE_FIELD_FILTERS_ENABLED). */
  filters?: boolean;
  /** Vizzy reads text fields an admin let it read (AUDIENCE_VIZZY_TEXT_FIELDS_ENABLED, from the server). */
  vizzyText?: boolean;
}) {
  const [object, setObject] = useState<RecordFieldObject>("person");
  const [lists, setLists] = useState<Record<RecordFieldObject, StoredFieldList> | null>(null);
  const [history, setHistory] = useState<FieldVersionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    void loadFieldLists().then((r) => (r.ok ? setLists(r.data.lists) : setLoadFailed(true)));
  }, []);
  const refreshHistory = useCallback(() => {
    setHistory(null);
    void loadFieldHistory(object).then((r) => setHistory(r.ok ? r.data.versions : []));
  }, [object]);
  useEffect(() => refreshHistory(), [refreshHistory]);

  if (loadFailed) return <Banner tone="err">Couldn&rsquo;t load the fields. Reload the page to try again.</Banner>;
  if (!lists) return <p className="text-sm text-neutral-500">Loading…</p>;

  const list = lists[object];
  const live = list.items.filter((f) => !f.archivedAt);
  const archived = list.items.filter((f) => f.archivedAt);
  const words = OBJECT_WORD[object];
  const filterable = (f: RecordField) => filters && object === "person" && isFilterType(f.type);
  const columns = vizzyText ? 6 : 5;

  async function apply(change: FieldListChange): Promise<boolean> {
    setBusy(true);
    setError(null);
    const r = await changeFieldList(object, list.rev, change);
    setBusy(false);
    if (!r.ok) {
      setError(fieldErrorText(r.data));
      return false;
    }
    setLists((cur) => (cur ? { ...cur, [object]: r.data.list } : cur));
    refreshHistory();
    return true;
  }

  return (
    <div className="flex flex-wrap items-start gap-5">
      <nav className="flex w-full flex-col gap-1 sm:w-48" aria-label="Kinds of record">
        {(["person", "company"] as const).map((o) => (
          <button
            key={o}
            type="button"
            aria-pressed={object === o}
            onClick={() => {
              setObject(o);
              setEditing(null);
              setError(null);
            }}
            className={`flex items-center justify-between rounded-md px-3 py-2 text-sm ${object === o ? "bg-neutral-100 font-medium dark:bg-neutral-900" : "hover:bg-neutral-50 dark:hover:bg-neutral-900/50"}`}
          >
            {OBJECT_WORD[o].tab}
            <span className="tabular-nums text-neutral-500">{lists[o].items.filter((f) => !f.archivedAt).length + readOnly[o].length}</span>
          </button>
        ))}
        <p className="px-3 pt-1 text-xs text-neutral-500">Your own kinds of record come later.</p>
      </nav>

      <div className="min-w-0 flex-[1_1_32rem] space-y-4">
        <h2 className="text-base font-semibold">Fields on {words.tab}</h2>
        {error ? <Banner tone="err">{error}</Banner> : null}
        <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
          <table className={`w-full text-sm ${vizzyText ? "min-w-[640px]" : "min-w-[560px]"}`}>
            <thead className="text-left text-xs text-neutral-500">
              <tr className="border-b border-neutral-200 dark:border-neutral-800">
                <th className="px-3 py-2 font-medium">Field</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Comes from</th>
                <th className="px-3 py-2 font-medium">In filters</th>
                {vizzyText ? <th className="px-3 py-2 font-medium">Vizzy reads</th> : null}
                <th className="px-3 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-900">
              {live.map((f) => (
                <FieldRow
                  key={f.key}
                  field={f}
                  inFilters={filterable(f)}
                  vizzyText={vizzyText}
                  columns={columns}
                  canEdit={canEdit}
                  open={editing === f.key}
                  busy={busy}
                  onToggle={() => setEditing(editing === f.key ? null : f.key)}
                  apply={apply}
                />
              ))}
              {readOnly[object].map((d) => (
                <tr key={d.key}>
                  <td className="px-3 py-2">{d.label}</td>
                  <td className="px-3 py-2">
                    <span className={typeTag}>{d.typeLabel}</span>
                  </td>
                  <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">
                    {d.source} <span className="ml-1 text-xs text-neutral-500">read only</span>
                  </td>
                  <td className={`px-3 py-2 ${d.inFilters === "Yes" ? "" : "text-neutral-500"}`}>{d.inFilters}</td>
                  {vizzyText ? <td /> : null}
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {archived.length ? (
          <section className="space-y-2 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
            <h3 className="text-sm font-semibold">Archived ({archived.length})</h3>
            <ul className="space-y-1 text-sm">
              {archived.map((f) => (
                <li key={f.key} className="flex flex-wrap items-center gap-2">
                  <span>{f.label}</span>
                  <span className={typeTag}>{FIELD_TYPE_LABEL[f.type]}</span>
                  {f.replacedBy ? <span className="text-xs text-neutral-500">replaced by a new {FIELD_TYPE_LABEL[list.items.find((x) => x.key === f.replacedBy)?.type ?? f.type]} field</span> : null}
                  {canEdit ? (
                    <button type="button" disabled={busy} className="text-xs underline underline-offset-2 disabled:opacity-50" onClick={() => void apply({ op: "restore", key: f.key })}>
                      Bring back
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="text-xs text-neutral-500">Hidden and read only. Its values are kept on each {words.each}, and it can be brought back.</p>
          </section>
        ) : null}
      </div>

      <aside className="flex w-full flex-col gap-4 lg:w-72">
        {canEdit ? <AddField object={object} busy={busy} filters={filters} vizzyText={vizzyText} apply={apply} /> : null}
        <section className="space-y-2 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
          <h3 className="text-sm font-semibold">Changes</h3>
          {!history ? (
            <p className="text-xs text-neutral-500">Loading…</p>
          ) : history.length === 0 ? (
            <p className="text-xs text-neutral-500">No changes yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {history.slice(0, 20).map((v) => (
                <li key={v.rev}>
                  <div>{versionText(v)}</div>
                  <div className="text-xs text-neutral-500" title={day(v.savedAt)}>
                    {v.by} · {ago(v.savedAt)} · version {v.rev}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-neutral-500">Every change is kept. Restoring an older list comes with settings history.</p>
        </section>
      </aside>
    </div>
  );
}

function FieldRow({
  field,
  inFilters,
  vizzyText,
  columns,
  canEdit,
  open,
  busy,
  onToggle,
  apply,
}: {
  field: RecordField;
  inFilters: boolean;
  /** Show the "Vizzy reads" column and the tick (AUDIENCE_VIZZY_TEXT_FIELDS_ENABLED). */
  vizzyText: boolean;
  columns: number;
  canEdit: boolean;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  apply: (change: FieldListChange) => Promise<boolean>;
}) {
  const [label, setLabel] = useState(field.label);
  const [option, setOption] = useState("");
  const [type, setType] = useState<FieldType>(field.type);
  const read = vizzyReadsField(field, true);
  return (
    <>
      <tr>
        <td className="px-3 py-2 font-medium">{field.label}</td>
        <td className="px-3 py-2">
          <span className={typeTag}>{FIELD_TYPE_LABEL[field.type]}</span>
        </td>
        <td className="px-3 py-2">Your field</td>
        <td className={`px-3 py-2 ${inFilters ? "" : "text-neutral-500"}`}>{inFilters ? "Yes" : "No"}</td>
        {vizzyText ? <td className={`px-3 py-2 ${read ? "" : "text-neutral-500"}`}>{read ? "Yes" : "No"}</td> : null}
        <td className="px-3 py-2 text-right">
          {canEdit ? (
            <button type="button" aria-expanded={open} className="text-xs underline underline-offset-2" onClick={onToggle}>
              {open ? "Close" : "Edit"}
            </button>
          ) : null}
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={columns} className="space-y-3 bg-neutral-50 px-3 py-3 dark:bg-neutral-900/40">
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-0 flex-1 space-y-1">
                <span className="text-xs text-neutral-500">Name</span>
                <input value={label} maxLength={FIELD_LIMITS.labelChars} onChange={(e) => setLabel(e.target.value)} className={inputClass} />
              </label>
              <Button disabled={busy || !label.trim() || label.trim() === field.label} onClick={() => void apply({ op: "rename", key: field.key, label })}>
                Rename
              </Button>
            </div>
            {hasOptions(field.type) ? (
              <div className="space-y-1.5">
                <span className="text-xs text-neutral-500">Options</span>
                <ul className="flex flex-wrap gap-1.5 text-xs">
                  {(field.options ?? []).map((o) => (
                    <li key={o.id} className={`flex items-center gap-1 rounded border px-1.5 py-0.5 ${o.archivedAt ? "border-dashed text-neutral-500" : "border-neutral-300 dark:border-neutral-700"}`}>
                      {o.label}
                      <button
                        type="button"
                        disabled={busy}
                        className="underline underline-offset-2"
                        onClick={() => void apply({ op: o.archivedAt ? "restore_option" : "archive_option", key: field.key, optionId: o.id })}
                      >
                        {o.archivedAt ? "bring back" : "archive"}
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="flex gap-2">
                  <input value={option} maxLength={FIELD_LIMITS.labelChars} onChange={(e) => setOption(e.target.value)} placeholder="New option" aria-label="New option" className={inputClass} />
                  <Button
                    disabled={busy || !option.trim()}
                    onClick={() => void apply({ op: "add_option", key: field.key, label: option }).then((ok) => ok && setOption(""))}
                  >
                    Add option
                  </Button>
                </div>
              </div>
            ) : null}
            {vizzyText && canVizzyReadText(field) ? (
              <div className="space-y-0.5">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={field.vizzyReads === true} disabled={busy} onChange={(e) => void apply({ op: "vizzy_reads", key: field.key, on: e.target.checked })} />
                  Vizzy can read this field
                </label>
                <p className="text-xs text-neutral-500">{VIZZY_READS_HINT}</p>
              </div>
            ) : null}
            <div className="flex flex-wrap items-end gap-2">
              <label className="space-y-1">
                <span className="text-xs text-neutral-500">Change the type</span>
                <select value={type} onChange={(e) => setType(e.target.value as FieldType)} className={inputClass}>
                  {FIELD_TYPES.filter((t) => t !== "currency").map((t) => (
                    <option key={t} value={t}>
                      {FIELD_TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                disabled={busy || type === field.type}
                onClick={() =>
                  void apply({ op: "change_type", key: field.key, type, ...(hasOptions(type) ? { options: (field.options ?? []).filter((o) => !o.archivedAt).map((o) => o.label) } : {}) })
                }
              >
                Change type
              </Button>
              <Button tone="danger" disabled={busy} onClick={() => void apply({ op: "archive", key: field.key })}>
                Archive field
              </Button>
            </div>
            <p className="text-xs text-neutral-500">
              A type is fixed once a field is made: changing it makes a new field with the same name and archives this one, with its values.
            </p>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function AddField({
  object,
  busy,
  filters,
  vizzyText,
  apply,
}: {
  object: RecordFieldObject;
  busy: boolean;
  filters: boolean;
  vizzyText: boolean;
  apply: (change: FieldListChange) => Promise<boolean>;
}) {
  const [label, setLabel] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const [options, setOptions] = useState("");
  const [currency, setCurrency] = useState("");
  const [vizzyReads, setVizzyReads] = useState(false);
  const canTick = vizzyText && canVizzyReadText({ type, object });
  const optionList = options
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const ready = !!label.trim() && (type !== "currency" || CURRENCY_CODE.test(currency.trim().toUpperCase())) && (!hasOptions(type) || optionList.length > 0);
  async function add() {
    const ok = await apply({
      op: "add",
      label,
      type,
      ...(hasOptions(type) ? { options: optionList } : {}),
      ...(type === "currency" ? { currency: currency.trim().toUpperCase() } : {}),
      ...(canTick && vizzyReads ? { vizzyReads: true } : {}),
    });
    if (ok) {
      setLabel("");
      setOptions("");
      setCurrency("");
      setVizzyReads(false);
    }
  }
  return (
    <section className="space-y-2 rounded-md border border-neutral-200 p-3 dark:border-neutral-800" aria-label="Add field">
      <h3 className="text-sm font-semibold">Add field</h3>
      <label className="block space-y-1">
        <span className="text-xs text-neutral-500">Name</span>
        <input value={label} maxLength={FIELD_LIMITS.labelChars} onChange={(e) => setLabel(e.target.value)} className={inputClass} />
      </label>
      <span className="block text-xs text-neutral-500">Type, fixed once the field is made</span>
      <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Type">
        {FIELD_TYPES.map((t) => (
          <button key={t} type="button" role="radio" aria-checked={type === t} className={chip(type === t)} onClick={() => setType(t)}>
            {FIELD_TYPE_LABEL[t]}
          </button>
        ))}
      </div>
      {hasOptions(type) ? (
        <label className="block space-y-1">
          <span className="text-xs text-neutral-500">Options, one per line</span>
          <textarea value={options} rows={3} onChange={(e) => setOptions(e.target.value)} className={inputClass} />
        </label>
      ) : null}
      {type === "currency" ? (
        <label className="block space-y-1">
          <span className="text-xs text-neutral-500">Currency code, such as GBP or USD</span>
          <input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value)} className={inputClass} />
        </label>
      ) : null}
      {canTick ? (
        <div className="space-y-0.5">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={vizzyReads} onChange={(e) => setVizzyReads(e.target.checked)} />
            Vizzy can read this field
          </label>
          <p className="text-xs text-neutral-500">{VIZZY_READS_HINT}</p>
        </div>
      ) : null}
      {object === "person" && filters ? <p className="text-xs text-neutral-500">Select, multi select, status and checkbox fields can filter People.</p> : null}
      <Button tone="primary" disabled={busy || !ready} onClick={() => void add()}>
        Add field
      </Button>
    </section>
  );
}
