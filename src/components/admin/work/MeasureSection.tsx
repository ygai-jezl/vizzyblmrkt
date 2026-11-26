"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, CheckCircle2, Lightbulb, Sparkles } from "lucide-react";
import { Button } from "@/components/admin/connect/ui";
import { draftOfMeasure, measureInputOf, measureProblems, type MeasureDraft } from "@/lib/work/form";
import { suggestMeasureKind } from "@/lib/work/measureKind";
import { lookWords, MEASURE_KIND_LABEL, measureHint, measureWhat, proposedLine, WORK_COPY } from "@/lib/work/screenWords";
import type { Measure, ThenMeasure, WorkTask } from "@/lib/work/types";
import type { MeaningKey } from "@/lib/metrics/meanings";
import type { ProductOption } from "@/lib/work/screens";
import { MeasurePicker } from "./MeasurePicker";
import { useFocusSwap } from "./useFocusSwap";

type Part = Exclude<Measure, { kind: "done" }> | ThenMeasure;

function PartView({ p, label, connection, event }: { p: Part; label: string; connection: (id: string) => string | undefined; event: (connectionId: string, name: string) => string | undefined }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{label}</p>
      <p className="font-medium">{MEASURE_KIND_LABEL[p.kind]}</p>
      <p className="text-neutral-600 dark:text-neutral-300">{measureWhat(p, { connection, event })}</p>
      <p className="flex flex-wrap items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
        {p.kind === "moves" ? (
          <span className="inline-flex items-center gap-0.5">
            {p.direction === "down" ? <ArrowDown size={12} aria-hidden /> : <ArrowUp size={12} aria-hidden />}
            {p.direction === "down" ? "Down" : "Up"}
          </span>
        ) : null}
        <span>{lookWords(p.look)}</span>
      </p>
    </div>
  );
}

/**
 * How we'll know it worked, on the task page: the kind of win, what it counts or the number and its
 * direction, when to look, the optional then, and the suggested kind beside the one kept. Change
 * opens the same picker as the add page, on the measure as it is now (never one read before the
 * page last read itself again); the server proposes the kind again and keeps both.
 */
export function MeasureSection({
  task,
  onSave,
  busy,
  products,
  meanings,
  operator,
  runsInApp,
  word,
  oneBrand,
  ideaWords,
}: {
  task: WorkTask;
  onSave: (m: ReturnType<typeof measureInputOf>) => Promise<boolean>;
  busy: boolean;
  products: ProductOption[] | null;
  meanings: MeaningKey[];
  operator: boolean;
  runsInApp: boolean;
  word: string | null;
  oneBrand: boolean;
  /** This copy calls a launch an idea: the rule's reason says so. */
  ideaWords: boolean;
}) {
  const m = task.measure;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<MeasureDraft>(() => draftOfMeasure(m));
  const focus = useFocusSwap(editing);
  const open = () => {
    setDraft(draftOfMeasure(m));
    setEditing(true);
  };
  const connection = (id: string) => products?.find((p) => p.id === id)?.name;
  // An event as the picker names it: its catalog label, else its name.
  const event = (connectionId: string, name: string) => {
    const e = products?.find((p) => p.id === connectionId)?.events.find((x) => x.name === name);
    return e && e.label !== e.name ? e.label : undefined;
  };
  const suggestion = suggestMeasureKind({ title: task.title, description: task.description, stage: task.stage, brandId: task.brandId, ideaId: task.ideaId, typedLinks: task.typedLinks, oneBrand, ideaWords });
  if (editing) {
    return (
      <div ref={focus.form} className="space-y-3">
        <MeasurePicker idPrefix="wk-t-ms" value={draft} onChange={setDraft} suggestion={suggestion} products={products} meanings={meanings} operator={operator} runsInApp={runsInApp} word={word} />
        <div className="flex gap-2">
          <Button
            tone="primary"
            disabled={busy || measureProblems(draft).length > 0}
            onClick={async () => {
              if (await onSave(measureInputOf(draft))) setEditing(false);
            }}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button onClick={() => setEditing(false)}>Cancel</Button>
        </div>
      </div>
    );
  }
  if (!m) {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-neutral-500 dark:text-neutral-400">{WORK_COPY.measureNone}</p>
        <span ref={focus.opener}>
          <Button onClick={open}>Add a measure</Button>
        </span>
      </div>
    );
  }
  const proposed = proposedLine(m);
  const hint = measureHint(task, m);
  return (
    <div className="space-y-3 text-sm">
      {m.kind === "done" ? (
        <p className="flex items-start gap-1.5">
          <CheckCircle2 size={14} aria-hidden className="mt-0.5 shrink-0 text-green-600" />
          <span>
            <strong>Done is the win.</strong> {WORK_COPY.measureDone}
          </span>
        </p>
      ) : (
        <>
          <PartView p={m} label="Kind of win" connection={connection} event={event} />
          {m.then ? <PartView p={m.then} label={`Then: ${MEASURE_KIND_LABEL[m.then.kind]}`} connection={connection} event={event} /> : null}
          {hint ? <p className="text-xs text-neutral-500 dark:text-neutral-400">{hint}</p> : null}
        </>
      )}
      {proposed ? (
        <p className="flex items-start gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
          {m.proposed?.by === "vizzy" ? <Sparkles size={12} aria-hidden className="mt-0.5 shrink-0 text-sky-600" /> : <Lightbulb size={12} aria-hidden className="mt-0.5 shrink-0" />}
          <span>{proposed}</span>
        </p>
      ) : null}
      <span ref={focus.opener}>
        <Button onClick={open}>Change</Button>
      </span>
    </div>
  );
}
