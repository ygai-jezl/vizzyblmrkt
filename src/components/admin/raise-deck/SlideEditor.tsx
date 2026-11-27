"use client";

import type { TextField } from "@/lib/raise/docs/edit";
import { LAYOUTS, pointsCap } from "@/lib/raise/docs/layouts";
import { LAYOUT_KEYS, RAISE_DOC_LIMITS as L, type DeckStage, type LayoutKey, type Slide } from "@/lib/raise/docs/types";
import { EDITOR_WORDS, LAYOUT_LABEL, SECTION_LABEL, STUDIO_WORDS } from "@/lib/raise/docs/words";
import { TokenText } from "./TokenText";

const FIELD = "w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900";
const SMALL = "text-xs text-blue-700 hover:underline disabled:opacity-50 dark:text-blue-300";

export interface SlideEditorProps {
  slide: Slide;
  n: number;
  stage: DeckStage;
  canEdit: boolean;
  now: Date;
  onChange: (slide: Slide) => void;
  onFocusField: (field: TextField) => void;
  onRemoveBlock: (blockId: string) => void;
  onInsertNumber: () => void;
}

/**
 * The slide's words under it: headline, points, the two columns, the people and the speaker notes,
 * with the fields its layout shows. Numbers sit in the words as chips. Members read it all.
 */
export function SlideEditor({ slide, n, stage, canEdit, now, onChange, onFocusField, onRemoveBlock, onInsertNumber }: SlideEditorProps) {
  const spec = LAYOUTS[slide.layout];
  const cap = pointsCap(slide.layout, slide.section, stage);
  const set = (patch: Partial<Slide>) => onChange({ ...slide, ...patch });
  const id = (what: string) => `rd-${slide.id}-${what}`;
  const text = (what: string, label: string, value: string, change: (v: string) => void, field: TextField | null, max: number, multiline = false) => (
    <TokenText
      id={id(what)}
      label={label}
      value={value}
      blocks={slide.blocks}
      onChange={change}
      onFocus={field ? () => onFocusField(field) : undefined}
      onRemoveBlock={onRemoveBlock}
      multiline={multiline}
      readOnly={!canEdit}
      maxLength={max}
      now={now}
    />
  );
  const full = slide.blocks.length >= L.blocks;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <span className="text-xs text-neutral-500">
          {STUDIO_WORDS.slideN(n)}, {SECTION_LABEL[slide.section]}
        </span>
        {canEdit ? (
          <label className="ml-auto flex items-center gap-2 text-xs">
            {EDITOR_WORDS.layout}
            <select value={slide.layout} onChange={(e) => set({ layout: e.target.value as LayoutKey })} className="rounded-md border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900">
              {LAYOUT_KEYS.map((k) => (
                <option key={k} value={k}>
                  {LAYOUT_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {text("headline", EDITOR_WORDS.headline, slide.headline, (v) => set({ headline: v }), { kind: "headline" }, L.headline)}

      {spec.points > 0 && (canEdit || slide.points.length) ? (
        <div className="space-y-2">
          <span className="block text-xs font-medium text-neutral-600 dark:text-neutral-400">{EDITOR_WORDS.points}</span>
          {slide.points.slice(0, Math.max(cap, slide.points.length)).map((p, i) => (
            <div key={i} className="flex items-start gap-2">
              <div className="flex-1">
                {text(`point-${i}`, EDITOR_WORDS.point(i + 1), p, (v) => set({ points: slide.points.map((x, k) => (k === i ? v : x)) }), { kind: "point", i }, L.point)}
              </div>
              {canEdit ? (
                <button type="button" className={`${SMALL} mt-6`} onClick={() => set({ points: slide.points.filter((_, k) => k !== i) })}>
                  {EDITOR_WORDS.removePoint}
                </button>
              ) : null}
            </div>
          ))}
          {canEdit && slide.points.length < cap ? (
            <button type="button" className={SMALL} onClick={() => set({ points: [...slide.points, ""] })}>
              {EDITOR_WORDS.addPoint}
            </button>
          ) : null}
        </div>
      ) : null}

      {spec.compare ? <CompareFields slide={slide} canEdit={canEdit} now={now} set={set} onRemoveBlock={onRemoveBlock} /> : null}

      {spec.people > 0 ? <PeopleFields slide={slide} canEdit={canEdit} set={set} /> : null}

      {canEdit ? (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={onInsertNumber} disabled={full} className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700">
            {STUDIO_WORDS.insertNumber}
          </button>
          {full ? <span className="text-xs text-neutral-500">{EDITOR_WORDS.full}</span> : null}
        </div>
      ) : null}

      {text("notes", STUDIO_WORDS.speakerNotes, slide.notes, (v) => set({ notes: v }), { kind: "notes" }, L.notes, true)}
    </div>
  );
}

function CompareFields({ slide, canEdit, now, set, onRemoveBlock }: { slide: Slide; canEdit: boolean; now: Date; set: (p: Partial<Slide>) => void; onRemoveBlock: (blockId: string) => void }) {
  const c = slide.compare ?? { leftTitle: "", rightTitle: "", rows: [] };
  const put = (next: typeof c) => set({ compare: next });
  // A cell may hold a number: it shows as a chip, as in the headline.
  const cell = (i: number, side: "left" | "right") => (
    <TokenText
      id={`rd-${slide.id}-${side}-${i}`}
      label={`${side === "left" ? EDITOR_WORDS.leftTitle : EDITOR_WORDS.rightTitle} ${i + 1}`}
      hideLabel
      value={c.rows[i]![side]}
      blocks={slide.blocks}
      onChange={(v) => put({ ...c, rows: c.rows.map((x, k) => (k === i ? { ...x, [side]: v } : x)) })}
      onRemoveBlock={onRemoveBlock}
      readOnly={!canEdit}
      maxLength={L.compareCell}
      now={now}
    />
  );
  if (!canEdit) {
    return (
      <div className="grid gap-2 text-sm sm:grid-cols-2">
        <strong>{c.leftTitle}</strong>
        <strong>{c.rightTitle}</strong>
        {c.rows.flatMap((_, i) => [<div key={`l${i}`}>{cell(i, "left")}</div>, <div key={`r${i}`}>{cell(i, "right")}</div>])}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <span className="block text-xs font-medium text-neutral-600 dark:text-neutral-400">{EDITOR_WORDS.columns}</span>
      <div className="grid gap-2 sm:grid-cols-2">
        <input aria-label={EDITOR_WORDS.leftTitle} placeholder={EDITOR_WORDS.leftTitle} value={c.leftTitle} maxLength={L.compareTitle} onChange={(e) => put({ ...c, leftTitle: e.target.value })} className={`${FIELD} font-semibold`} />
        <input aria-label={EDITOR_WORDS.rightTitle} placeholder={EDITOR_WORDS.rightTitle} value={c.rightTitle} maxLength={L.compareTitle} onChange={(e) => put({ ...c, rightTitle: e.target.value })} className={`${FIELD} font-semibold`} />
        {c.rows.map((_, i) => (
          <div key={i} className="contents">
            {cell(i, "left")}
            <div className="flex items-center gap-2">
              <div className="flex-1">{cell(i, "right")}</div>
              <button type="button" className={SMALL} onClick={() => put({ ...c, rows: c.rows.filter((_, k) => k !== i) })}>
                {EDITOR_WORDS.removeRow}
              </button>
            </div>
          </div>
        ))}
      </div>
      {c.rows.length < L.compareRows ? (
        <button type="button" className={SMALL} onClick={() => put({ ...c, rows: [...c.rows, { left: "", right: "" }] })}>
          {EDITOR_WORDS.addRow}
        </button>
      ) : null}
    </div>
  );
}

function PeopleFields({ slide, canEdit, set }: { slide: Slide; canEdit: boolean; set: (p: Partial<Slide>) => void }) {
  const people = slide.people ?? [];
  const put = (next: typeof people) => set({ people: next });
  if (!canEdit) {
    return (
      <ul className="space-y-1 text-sm">
        {people.map((p, i) => (
          <li key={i}>
            <strong>{p.name}</strong>, {p.role}. {p.line}
          </li>
        ))}
      </ul>
    );
  }
  const field = (i: number, key: "name" | "role" | "line", label: string, max: number) => (
    <input aria-label={`${label} ${i + 1}`} placeholder={label} value={people[i]![key]} maxLength={max} onChange={(e) => put(people.map((x, k) => (k === i ? { ...x, [key]: e.target.value } : x)))} className={FIELD} />
  );
  return (
    <div className="space-y-2">
      <span className="block text-xs font-medium text-neutral-600 dark:text-neutral-400">{EDITOR_WORDS.people}</span>
      {people.map((_, i) => (
        <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_2fr_auto]">
          {field(i, "name", EDITOR_WORDS.name, L.personName)}
          {field(i, "role", EDITOR_WORDS.role, L.personRole)}
          {field(i, "line", EDITOR_WORDS.line, L.personLine)}
          <button type="button" className={SMALL} onClick={() => put(people.filter((_, k) => k !== i))}>
            {EDITOR_WORDS.removePerson}
          </button>
        </div>
      ))}
      {people.length < L.people ? (
        <button type="button" className={SMALL} onClick={() => put([...people, { name: "", role: "", line: "" }])}>
          {EDITOR_WORDS.addPerson}
        </button>
      ) : null}
    </div>
  );
}
