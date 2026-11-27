"use client";

import { CheckCircle2, Lightbulb, Sparkles } from "lucide-react";
import { inputClass } from "@/components/admin/connect/ui";
import type { MeaningKey } from "@/lib/metrics/meanings";
import { LOOPS } from "@/lib/loops/registry";
import { PURPOSE_LABELS, RESOURCES, type ResourcePurpose } from "@/lib/plans/resources";
import { measureProblems, PRODUCT_EVENT_DAYS, thenFor, withMeaning, type MeasureDraft, type PartDraft } from "@/lib/work/form";
import { keptLine, kindHint, MEASURE_KIND_LABEL, meaningLabel, productEventHint, RUNS_BETTER_LABEL, runsBetterHint, suggestionLine, WORK_COPY } from "@/lib/work/screenWords";
import { MEASURE_KINDS, RUNS_BETTER_WHAT, type MeasureKind } from "@/lib/work/types";
import type { ProductOption } from "@/lib/work/screens";

const PURPOSES = [...new Set(Object.values(RESOURCES).flatMap((r) => r.purposes as readonly ResourcePurpose[]))];
const LOOP_KINDS = Object.keys(LOOPS);

export interface MeasurePickerProps {
  value: MeasureDraft;
  onChange: (next: MeasureDraft) => void;
  /** The kind the rule (or Vizzy) proposes for the task as it stands. */
  suggestion: { kind: MeasureKind; reason: string } | null;
  suggestedBy?: "rule" | "vizzy";
  /** The connected products of the brand the task counts for; null when it counts for no one brand. */
  products: ProductOption[] | null;
  meanings: MeaningKey[];
  /** Named by LOOPS_OPERATOR_EMAILS: may count this copy's own purposes, types and loop kinds. */
  operator: boolean;
  /** A repo or a product is connected, so crashes and memory make sense. */
  runsInApp: boolean;
  /** The brand's word for conversions, to start the field with. */
  word: string | null;
  idPrefix: string;
}

const RADIO = (on: boolean) =>
  `flex flex-col items-start rounded-md border px-2.5 py-1.5 text-left text-sm ${
    on ? "border-sky-400 bg-sky-50 dark:border-sky-700 dark:bg-sky-950/40" : "border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
  }`;

/**
 * How we'll know it worked (ADR-0020): one of four kinds of win, the suggested one marked with its
 * reason, that kind's fields, when to look, and an optional then. The server proposes the kind
 * again on save and keeps both the proposal and the pick, so overrides can teach the suggestion.
 */
export function MeasurePicker({ value, onChange, suggestion, suggestedBy = "rule", products, meanings, operator, runsInApp, word, idPrefix }: MeasurePickerProps) {
  const d = value;
  const set = (patch: Partial<MeasureDraft>) => onChange({ ...d, ...patch });
  const pickKind = (k: MeasureKind) => {
    if (k === "done") return set({ kind: "done", then: null });
    const first = { ...d.first, kind: k, word: d.first.word || word || "" };
    set({ kind: k, first });
  };
  const problems = measureProblems(d);
  return (
    <div className="space-y-3">
      <p className="flex items-start gap-1.5 text-sm text-neutral-600 dark:text-neutral-400">
        {suggestedBy === "vizzy" ? <Sparkles size={14} aria-hidden className="mt-0.5 shrink-0 text-sky-600" /> : <Lightbulb size={14} aria-hidden className="mt-0.5 shrink-0" />}
        <span>{suggestionLine(suggestion, suggestedBy)}</span>
      </p>
      <div role="group" aria-labelledby={`${idPrefix}-k`} className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p id={`${idPrefix}-k`} className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
            Kind of win
          </p>
          {d.kind ? (
            <button type="button" onClick={() => set({ kind: null, then: null })} className="text-xs text-neutral-500 underline underline-offset-4">
              No measure
            </button>
          ) : null}
        </div>
        <div role="radiogroup" aria-labelledby={`${idPrefix}-k`} className="grid grid-cols-2 gap-1.5">
          {MEASURE_KINDS.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={d.kind === k} onClick={() => pickKind(k)} className={RADIO(d.kind === k)}>
              <span className="font-medium">{MEASURE_KIND_LABEL[k]}</span>
              <span className="text-xs text-neutral-500 dark:text-neutral-400">{suggestion?.kind === k ? (suggestedBy === "vizzy" ? "Vizzy suggests" : "Suggested") : kindHint(k, runsInApp)}</span>
            </button>
          ))}
        </div>
        {d.kind === "done" ? (
          <p className="flex items-start gap-1.5 text-sm">
            <CheckCircle2 size={14} aria-hidden className="mt-0.5 shrink-0 text-green-600" />
            <span>
              <strong>Done is the win.</strong> {WORK_COPY.measureDone}
            </span>
          </p>
        ) : null}
        {d.kind && d.kind !== "done" ? (
          <PartFields
            part={{ ...d.first, kind: d.kind }}
            onPart={(p) => set({ first: p, then: d.then && d.then.lookBy === "days" && p.lookBy === "days" && d.then.days <= p.days ? { ...d.then, days: Math.min(365, p.days + 1) } : d.then })}
            isThen={false}
            minDays={1}
            products={products}
            meanings={meanings}
            operator={operator}
            runsInApp={runsInApp}
            idPrefix={`${idPrefix}-first`}
          />
        ) : null}
      </div>
      {d.kind && d.kind !== "done" && d.then ? (
        <div role="group" aria-labelledby={`${idPrefix}-then-k`} className="space-y-2 rounded-md border border-dashed border-neutral-300 p-2.5 dark:border-neutral-700">
          <div className="flex items-center justify-between gap-2">
            <p id={`${idPrefix}-then-k`} className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
              Then, a second measure
            </p>
            <button type="button" onClick={() => set({ then: null })} className="text-xs text-neutral-500 underline underline-offset-4">
              Remove the then
            </button>
          </div>
          <div role="radiogroup" aria-labelledby={`${idPrefix}-then-k`} className="flex flex-wrap gap-1.5">
            {MEASURE_KINDS.filter((k) => k !== "done").map((k) => (
              <button key={k} type="button" role="radio" aria-checked={d.then!.kind === k} onClick={() => set({ then: { ...d.then!, kind: k as PartDraft["kind"] } })} className={RADIO(d.then!.kind === k)}>
                <span className="font-medium">{MEASURE_KIND_LABEL[k]}</span>
              </button>
            ))}
          </div>
          <PartFields
            part={d.then}
            onPart={(p) => set({ then: p })}
            isThen
            minDays={d.first.lookBy === "days" ? d.first.days + 1 : 1}
            products={products}
            meanings={meanings}
            operator={operator}
            runsInApp={runsInApp}
            idPrefix={`${idPrefix}-then`}
          />
        </div>
      ) : null}
      {d.kind && d.kind !== "done" && !d.then ? (
        <button type="button" onClick={() => set({ then: thenFor(d) })} className="text-sm text-neutral-700 underline underline-offset-4 dark:text-neutral-300">
          Add a then (optional)
        </button>
      ) : null}
      {d.kind && suggestion && suggestion.kind !== d.kind ? <p className="text-xs text-neutral-500 dark:text-neutral-400">{keptLine(d.kind, suggestion.kind, suggestedBy)}</p> : null}
      {!d.kind ? <p className="text-xs text-neutral-500 dark:text-neutral-400">{WORK_COPY.measureFormNone}</p> : null}
      {problems.length ? (
        <ul role="alert" className="space-y-0.5 text-xs text-red-700 dark:text-red-400">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** What a Used measure counts, as the select keeps it. */
function countsValue(p: PartDraft, products: ProductOption[] | null): string {
  if (p.counts === "event") {
    const prod = products?.find((x) => x.id === p.connectionId);
    return prod?.events.some((e) => e.name === p.event) ? `ev|${p.connectionId}|${p.event}` : `evx|${p.connectionId}`;
  }
  return p.counts;
}

function PartFields({
  part: p,
  onPart,
  isThen,
  minDays,
  products,
  meanings,
  operator,
  runsInApp,
  idPrefix,
}: {
  part: PartDraft;
  onPart: (p: PartDraft) => void;
  isThen: boolean;
  minDays: number;
  products: ProductOption[] | null;
  meanings: MeaningKey[];
  operator: boolean;
  runsInApp: boolean;
  idPrefix: string;
}) {
  const set = (patch: Partial<PartDraft>) => onPart({ ...p, ...patch });
  const maxDays = p.kind === "used" && p.counts === "event" ? PRODUCT_EVENT_DAYS : 365;
  const onCounts = (v: string) => {
    if (v.startsWith("ev|")) {
      const [, id, name] = v.split("|");
      return set({ counts: "event", connectionId: id ?? "", event: name ?? "", lookBy: "days", days: Math.min(p.days, PRODUCT_EVENT_DAYS) });
    }
    if (v.startsWith("evx|")) return set({ counts: "event", connectionId: v.slice(4), event: "", lookBy: "days", days: Math.min(p.days, PRODUCT_EVENT_DAYS) });
    return set({ counts: v as PartDraft["counts"] });
  };
  const whats = RUNS_BETTER_WHAT.filter((w) => runsInApp || p.what === w || (w !== "crashes" && w !== "memory"));
  const many = (products?.length ?? 0) > 1;
  const product = products?.find((x) => x.id === p.connectionId);
  return (
    <div className="space-y-2">
      {p.kind === "used" ? (
        <label className="block space-y-1">
          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">What it counts</span>
          <select id={`${idPrefix}-ev`} value={countsValue(p, products)} onChange={(e) => onCounts(e.target.value)} className={inputClass}>
            <option value="none">{WORK_COPY.usedNone}</option>
            {(products ?? []).flatMap((x) =>
              x.events.map((e) => (
                <option key={`${x.id}${e.name}`} value={`ev|${x.id}|${e.name}`}>
                  {many ? `${e.label} (${x.name})` : e.label}
                </option>
              )),
            )}
            {(products ?? []).map((x) => (
              <option key={x.id} value={`evx|${x.id}`}>
                {`Another event from ${x.name}`}
              </option>
            ))}
            {operator ? <option value="purpose">An AI purpose of this copy</option> : null}
            {operator ? <option value="type">A type of record this copy keeps</option> : null}
            {operator ? <option value="loopKind">A loop kind of this copy</option> : null}
          </select>
          {p.counts === "event" && !product?.events.some((e) => e.name === p.event) ? (
            <input type="text" aria-label="Event name" placeholder="note_created" value={p.event} onChange={(e) => set({ event: e.target.value.trim() })} className={`${inputClass} font-mono`} />
          ) : null}
          {p.counts === "none" ? (
            <input type="text" aria-label="Why there's nothing to count (optional)" placeholder="Why there's nothing to count (optional)" maxLength={140} value={p.noneReason} onChange={(e) => set({ noneReason: e.target.value })} className={inputClass} />
          ) : null}
          {p.counts === "purpose" ? (
            <select aria-label="Purpose" value={p.purpose} onChange={(e) => set({ purpose: e.target.value })} className={inputClass}>
              <option value="">Pick a purpose</option>
              {PURPOSES.map((x) => (
                <option key={x} value={x}>
                  {PURPOSE_LABELS[x] ?? x}
                </option>
              ))}
            </select>
          ) : null}
          {p.counts === "type" ? <input type="text" aria-label="Record type" placeholder="work_task" value={p.type} onChange={(e) => set({ type: e.target.value.trim() })} className={`${inputClass} font-mono`} /> : null}
          {p.counts === "loopKind" ? (
            <select aria-label="Loop kind" value={p.loopKind} onChange={(e) => set({ loopKind: e.target.value })} className={inputClass}>
              <option value="">Pick a loop kind</option>
              {LOOP_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          ) : null}
          <span className="block text-xs text-neutral-500 dark:text-neutral-400">
            {p.counts === "event" && product ? productEventHint(product.name) : products === null && !isThen ? `${WORK_COPY.usedNoneHint} ${WORK_COPY.productNeedsBrand}` : WORK_COPY.usedNoneHint}
          </span>
        </label>
      ) : null}
      {p.kind === "moves" ? (
        <>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">The number</span>
            <select id={`${idPrefix}-n`} value={p.meaning} onChange={(e) => onPart(withMeaning(p, e.target.value as MeaningKey))} className={inputClass}>
              {meanings.map((k) => (
                <option key={k} value={k}>
                  {meaningLabel(k, p.word)}
                </option>
              ))}
            </select>
          </label>
          {p.meaning === "conversions" ? (
            <label className="block space-y-1">
              <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Your word for it</span>
              <input type="text" maxLength={40} placeholder="Sign ups, orders or bookings" value={p.word} onChange={(e) => set({ word: e.target.value })} className={inputClass} />
            </label>
          ) : null}
          <div role="radiogroup" aria-label="Which way it should move" className="flex gap-1.5">
            {(["up", "down"] as const).map((dir) => (
              <button key={dir} type="button" role="radio" aria-checked={p.direction === dir} onClick={() => set({ direction: dir })} className={RADIO(p.direction === dir)}>
                {dir === "up" ? "Up" : "Down"}
              </button>
            ))}
          </div>
          <span className="block text-xs text-neutral-500 dark:text-neutral-400">{WORK_COPY.movesHint}</span>
        </>
      ) : null}
      {p.kind === "runs_better" ? (
        <label className="block space-y-1">
          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">What should run better</span>
          <select id={`${idPrefix}-what`} value={p.what} onChange={(e) => set({ what: e.target.value as PartDraft["what"] })} className={inputClass}>
            {whats.map((w) => (
              <option key={w} value={w}>
                {RUNS_BETTER_LABEL[w]}
              </option>
            ))}
          </select>
          <span className="block text-xs text-neutral-500 dark:text-neutral-400">{runsBetterHint(p.what)}</span>
        </label>
      ) : null}
      <div className="space-y-1">
        <span className="block text-xs font-medium text-neutral-600 dark:text-neutral-400">When to look</span>
        <span className="flex flex-wrap items-center gap-2 text-sm">
          {p.lookBy === "days" ? (
            <input
              id={`${idPrefix}-days`}
              type="number"
              aria-label="Days after it's done"
              min={minDays}
              max={maxDays}
              value={p.days}
              onChange={(e) => set({ days: Math.round(e.target.valueAsNumber || p.days) })}
              className={`${inputClass} w-20`}
            />
          ) : (
            <select aria-label="Outputs" value={p.outputs} onChange={(e) => set({ outputs: Number(e.target.value) as PartDraft["outputs"] })} className={`${inputClass} w-20`}>
              {[10, 20, 40].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          )}
          <select
            aria-label="Counted by"
            value={p.lookBy}
            disabled={p.kind === "used" && p.counts === "event"}
            onChange={(e) => set({ lookBy: e.target.value as PartDraft["lookBy"] })}
            className={`${inputClass} w-auto`}
          >
            <option value="days">{WORK_COPY.daysAfterDone}</option>
            <option value="outputs">outputs</option>
          </select>
        </span>
        <span className="block text-xs text-neutral-500 dark:text-neutral-400">{p.lookBy === "outputs" ? WORK_COPY.outputsHint : isThen ? WORK_COPY.thenLookHint : WORK_COPY.lookHint}</span>
      </div>
    </div>
  );
}
