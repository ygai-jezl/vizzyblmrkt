"use client";

import { AlertTriangle, Plus, X } from "lucide-react";
import { amountToMinor, currencyDigits, minorToAmount, type RecordField } from "@/lib/types/recordField";
import { holdsTypedWords, isComplete, opsFor, type FilterFlag, type FilterKind } from "@/lib/views/conditions";
import { BUILT_IN_FILTERS, isBuiltInFilter, isEmptyOp, valueFits, VIEW_LIMITS, type BuiltInFilter, type ViewFilter, type ViewMatch, type ViewOp, type ViewValue } from "@/lib/views/types";
import { builtInFilterLabel, kindOf, OP_LABEL, optionName, optionsFor, VIEW_MESSAGES, type ViewNames } from "@/lib/views/words";
import { inputClass } from "../connect/ui";
import { Chip } from "../people/Chip";

/**
 * People's filter builder (CRM_VIEWS_ENABLED): All of these or Any of these, then up to 10 filters,
 * each one of the brand's fields or a built in one, a comparison and a value. A filter applies once
 * it is complete. A filter on an archived field is marked Archived and ignored; one with typed words
 * is marked, since a saved view can't keep them.
 */

/**
 * A filter as it is being built: `on` is "" until a field or built in filter is picked, and `op`
 * null until a comparison is; `text` and `text2` hold what was typed for a number or an amount.
 */
export interface DraftFilter {
  id: number;
  on: string;
  op: ViewOp | null;
  value?: ViewValue;
  text?: string;
  text2?: string;
}

let nextId = 1;
export function draftOf(f: Partial<ViewFilter> & { on: string; op: ViewOp }, fields: readonly RecordField[]): DraftFilter {
  const d: DraftFilter = { id: nextId++, on: f.on, op: f.op, value: f.value };
  const field = fields.find((x) => x.key === f.on);
  const asText = (n: unknown) => (typeof n !== "number" ? "" : field?.type === "currency" ? minorToAmount(n, field.currency) : String(n));
  if (Array.isArray(f.value) && f.op === "between") {
    d.text = asText(f.value[0]);
    d.text2 = asText(f.value[1]);
  } else if (typeof f.value === "number") d.text = asText(f.value);
  return d;
}

/** The filter a draft stands for, once it is complete. */
export function filterOf(d: DraftFilter): ViewFilter | null {
  if (!d.on || !d.op) return null;
  const f: Partial<ViewFilter> = { on: d.on, op: d.op, ...(isEmptyOp(d.op) ? {} : { value: d.value }) };
  return isComplete(f) && valueFits(f.op, f.value) ? f : null;
}

/** Add filter: a new filter with nothing picked, so it changes nothing until someone picks. */
export function blankDraft(): DraftFilter {
  return { id: nextId++, on: "", op: null };
}

/**
 * A filter just put on a field or a built in one: its first comparison and no value, so it applies
 * only once a value is picked. Email, phone and link fields offer only empty or not, so they start
 * with no comparison picked rather than applying "is empty" at once.
 */
export function newDraft(on: string, fields: readonly RecordField[]): DraftFilter {
  const kind = on ? kindOf(on, fields) : null;
  const op = kind ? (opsFor(kind)[0] ?? null) : null;
  return { id: nextId++, on, op: op && !isEmptyOp(op) ? op : null };
}

const selectClass = "rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950";

/** The built in filters this brand can use: ideas, products and stages only when it has them. */
export function builtInsFor(names: ViewNames, manyLaunches: boolean): BuiltInFilter[] {
  return BUILT_IN_FILTERS.filter((b) => {
    if (b === "launch") return (names.launches ?? []).length > 0;
    if (b === "launches_many") return manyLaunches;
    if (b === "product" || b === "stage" || b === "quiet") return (names.products ?? []).length > 0;
    if (b === "group") return !!names.group;
    return true;
  });
}

const capital = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

/** The options a filter picks; struck through when they are archived, or all of them when the filter's field is. */
function OptionsInput({ d, names, struck, onChange }: { d: DraftFilter; names: ViewNames; struck: boolean; onChange: (value: ViewValue | undefined) => void }) {
  const chosen = Array.isArray(d.value) ? (d.value as string[]) : [];
  const all = optionsFor(d.on, names);
  const label = (id: string) => all.find((o) => o.id === id);
  const left = all.filter((o) => !o.archived && !chosen.includes(o.id));
  return (
    <div className={`${inputClass} flex min-h-[34px] !w-auto min-w-[14rem] max-w-md flex-wrap items-center gap-1 !py-1`}>
      {chosen.map((id) => {
        const o = label(id);
        const text = o?.label ?? capital(optionName(d.on, id, names));
        return (
          <span key={id} className={`inline-flex items-center gap-1 rounded bg-neutral-100 px-1.5 text-xs dark:bg-neutral-800 ${struck || o?.archived ? "line-through opacity-70" : ""}`}>
            {text}
            <button type="button" aria-label={`Remove ${text}`} onClick={() => onChange(chosen.length > 1 ? chosen.filter((x) => x !== id) : undefined)}>
              <X size={11} aria-hidden />
            </button>
          </span>
        );
      })}
      {left.length && chosen.length < VIEW_LIMITS.values && !struck ? (
        <select
          aria-label="Add a value"
          value=""
          onChange={(e) => e.target.value && onChange([...chosen, e.target.value])}
          className="min-w-24 flex-1 border-0 bg-transparent py-0.5 text-sm text-neutral-500 focus:outline-none"
        >
          <option value="">{chosen.length ? "Add…" : "Pick…"}</option>
          {left.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

function ValueInput({ d, kind, field, names, onChange }: { d: DraftFilter; kind: FilterKind; field: RecordField | null; names: ViewNames; onChange: (patch: Partial<DraftFilter>) => void }) {
  if (!d.op || isEmptyOp(d.op)) return null;
  if (d.op === "any_of" || d.op === "all_of" || d.op === "none_of") return <OptionsInput d={d} names={names} struck={!!field?.archivedAt} onChange={(value) => onChange({ value })} />;
  if (d.op === "is") {
    return (
      <select
        aria-label="Yes or no"
        className={selectClass}
        value={d.value === true ? "yes" : d.value === false ? "no" : ""}
        onChange={(e) => onChange({ value: e.target.value ? e.target.value === "yes" : undefined })}
      >
        {typeof d.value === "boolean" ? null : <option value="">Pick…</option>}
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    );
  }
  if (d.op === "on" || d.op === "before" || d.op === "after") {
    return <input type="date" aria-label="Day" className={`${inputClass} max-w-[11rem]`} value={typeof d.value === "string" ? d.value : ""} onChange={(e) => onChange({ value: e.target.value || undefined })} />;
  }
  if (d.op === "in_last" || d.op === "in_next" || d.op === "over_ago") {
    return (
      <span className="inline-flex items-center gap-2">
        <input
          type="number"
          min={1}
          max={VIEW_LIMITS.days}
          step={1}
          aria-label="Days"
          className={`${inputClass} w-20`}
          value={typeof d.value === "number" ? d.value : ""}
          onChange={(e) => {
            const n = Number(e.target.value);
            onChange({ value: e.target.value && Number.isInteger(n) ? n : undefined });
          }}
        />
        <span className="text-sm text-neutral-500">{d.op === "over_ago" ? "days ago" : "days"}</span>
      </span>
    );
  }
  if (d.op === "contains" || d.op === "not_contains" || d.op === "equals" || d.op === "not_equals") {
    return (
      <input
        type="text"
        maxLength={VIEW_LIMITS.wordsChars}
        aria-label="Words"
        placeholder={kind === "words" ? "example.com" : "Type words"}
        className={`${inputClass} max-w-xs`}
        value={typeof d.value === "string" ? d.value : ""}
        onChange={(e) => onChange({ value: e.target.value.trim() ? e.target.value : undefined })}
      />
    );
  }
  // A number or an amount, typed in the currency's own units.
  const currency = field?.type === "currency" ? field.currency : null;
  const toValue = (text: string) => {
    if (!text.trim()) return undefined;
    const n = currency ? amountToMinor(text, currency) : Number(text);
    return Number.isFinite(n) ? n : undefined;
  };
  const step = currency ? 1 / 10 ** currencyDigits(currency) : "any";
  const box = (text: string | undefined, label: string, set: (t: string) => void) => (
    <input type="number" step={step} aria-label={label} className={`${inputClass} w-28`} value={text ?? ""} onChange={(e) => set(e.target.value)} />
  );
  if (d.op === "between") {
    const both = (a: string | undefined, b: string | undefined) => {
      const x = toValue(a ?? "");
      const y = toValue(b ?? "");
      return x !== undefined && y !== undefined ? ([x, y] as [number, number]) : undefined;
    };
    return (
      <span className="inline-flex items-center gap-2">
        {box(d.text, "From", (t) => onChange({ text: t, value: both(t, d.text2) }))}
        <span className="text-sm text-neutral-500">and</span>
        {box(d.text2, "To", (t) => onChange({ text2: t, value: both(d.text, t) }))}
        {currency ? <span className="text-xs text-neutral-500">{currency}</span> : null}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      {box(d.text, "Value", (t) => onChange({ text: t, value: toValue(t) }))}
      {currency ? <span className="text-xs text-neutral-500">{currency}</span> : null}
    </span>
  );
}

export function FilterBuilder({
  match,
  drafts,
  flags,
  names,
  manyLaunches,
  onMatch,
  onChange,
}: {
  match: ViewMatch;
  drafts: DraftFilter[];
  /** From the last run, by draft id: why a filter is ignored or narrowed now. */
  flags: Record<number, FilterFlag | null>;
  names: ViewNames;
  /** The brand counts people in more than one idea (LAUNCH_IDEAS_ENABLED). */
  manyLaunches: boolean;
  onMatch: (m: ViewMatch) => void;
  onChange: (drafts: DraftFilter[]) => void;
}) {
  const live = names.fields.filter((f) => !f.archivedAt && f.object === "person");
  const builtIns = builtInsFor(names, manyLaunches);
  const set = (id: number, patch: Partial<DraftFilter>) => onChange(drafts.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  const pickOn = (id: number, on: string) => onChange(drafts.map((d) => (d.id === id ? { ...newDraft(on, names.fields), id } : d)));
  const add = () => onChange([...drafts, blankDraft()]);
  return (
    <div className="space-y-2 rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800">
      <div className="flex items-center gap-2">
        <span className="text-neutral-600 dark:text-neutral-400">Show people who match</span>
        <select aria-label="Match" className={selectClass} value={match} onChange={(e) => onMatch(e.target.value === "any" ? "any" : "all")}>
          <option value="all">All of these</option>
          <option value="any">Any of these</option>
        </select>
      </div>
      {drafts.map((d) => {
        const field = isBuiltInFilter(d.on) ? null : (names.fields.find((f) => f.key === d.on) ?? null);
        const kind = kindOf(d.on, names.fields);
        const flag = flags[d.id] ?? (field?.archivedAt ? "archived_field" : null);
        const complete = filterOf(d);
        const typed = complete !== null && holdsTypedWords(complete);
        return (
          <div key={d.id} className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <select aria-label="Filter on" className={selectClass} value={d.on} onChange={(e) => pickOn(d.id, e.target.value)}>
                {d.on ? null : <option value="">Pick a filter…</option>}
                {live.length ? (
                  <optgroup label="Your fields">
                    {live.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {field && !live.includes(field) ? <option value={field.key}>{field.label} (archived)</option> : null}
                <optgroup label="People">
                  {builtIns.map((b) => (
                    <option key={b} value={b}>
                      {builtInFilterLabel(b, names.ideas)}
                    </option>
                  ))}
                  {/* A saved view's filter this page doesn't offer now, such as a product group opened without its ?group=. */}
                  {isBuiltInFilter(d.on) && !builtIns.includes(d.on) ? <option value={d.on}>{builtInFilterLabel(d.on, names.ideas)}</option> : null}
                </optgroup>
              </select>
              {kind && opsFor(kind).length > 1 ? (
                <select
                  aria-label="Comparison"
                  className={selectClass}
                  value={d.op ?? ""}
                  onChange={(e) => {
                    const op = (e.target.value || null) as ViewOp | null;
                    // Options carry over between any of, all of and none of; anything else starts again.
                    const keep = Array.isArray(d.value) && (op === "any_of" || op === "all_of" || op === "none_of");
                    set(d.id, { op, value: keep ? d.value : undefined, text: undefined, text2: undefined });
                  }}
                >
                  {d.op ? null : <option value="">Pick…</option>}
                  {opsFor(kind).map((op) => (
                    <option key={op} value={op}>
                      {OP_LABEL[op]}
                    </option>
                  ))}
                </select>
              ) : kind && d.op ? (
                <span className="px-1 text-neutral-600 dark:text-neutral-400">{OP_LABEL[d.op]}</span>
              ) : null}
              {kind ? <ValueInput d={d} kind={kind} field={field} names={names} onChange={(patch) => set(d.id, patch)} /> : null}
              {flag === "archived_field" || flag === "unknown_field" ? <Chip tone="amber">Archived</Chip> : null}
              {typed ? <Chip tone="amber">Typed words</Chip> : null}
              <button type="button" aria-label="Remove this filter" onClick={() => onChange(drafts.filter((x) => x.id !== d.id))} className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-900">
                <X size={14} aria-hidden />
              </button>
            </div>
            {flag === "archived_field" || flag === "unknown_field" ? (
              <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle size={12} aria-hidden /> {VIEW_MESSAGES.archived_field}
              </p>
            ) : flag === "archived_option" ? (
              <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle size={12} aria-hidden /> {VIEW_MESSAGES.archived_option}
              </p>
            ) : null}
          </div>
        );
      })}
      <div className="flex items-center justify-between pt-1">
        {drafts.length < VIEW_LIMITS.filters ? (
          <button type="button" onClick={add} className="inline-flex items-center gap-1 text-sm text-neutral-700 hover:underline dark:text-neutral-300">
            <Plus size={14} aria-hidden /> Add filter
          </button>
        ) : (
          <span className="text-xs text-neutral-500">A view holds up to {VIEW_LIMITS.filters} filters.</span>
        )}
        {drafts.length ? (
          <button type="button" onClick={() => onChange([])} className="text-xs text-neutral-500 hover:underline">
            Clear all
          </button>
        ) : null}
      </div>
    </div>
  );
}
