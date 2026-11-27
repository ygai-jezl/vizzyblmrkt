"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { Button, inputClass } from "@/components/admin/connect/ui";
import { Chip } from "@/components/admin/people/Chip";
import { stageLabel } from "@/lib/work/stages";
import { IMPORT_FIELDS, type ImportField } from "@/lib/work/inputs";
import { IMPORT_FIELD_LABEL, importButton, importedText, missingColumnsText, previewHint, WORK_COPY, WORK_STATUS_TONE } from "@/lib/work/screenWords";
import type { ImportDone, ImportPreview } from "@/lib/work/service";
import { workCall, workErrorText } from "./api";
import { WorkDialog } from "./WorkDialog";

type Source = "csv" | "paste";

/** The fields a sheet's missing columns would fill: what the person sets on each task after. */
const AFTER: Array<[ImportField, string]> = [
  ["stage", "Stage"],
  ["brand", "Brand"],
  ["check", "Check"],
];

/**
 * Import a Backlog tab (admins and owners): a CSV file, or rows pasted from Google Sheets. Preview
 * first: what each column fills (changeable), the first 20 rows, and what would be refused. Nothing
 * is added until Import. Refs are kept; new tasks start after the highest.
 */
export function ImportButton({ label = "Import", start = "paste", brands, wholeBusiness, tone = "secondary" }: { label?: string; start?: Source; brands: Array<{ id: string; name: string }>; wholeBusiness: boolean; tone?: "primary" | "secondary" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button tone={tone} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open ? <ImportDialog start={start} brands={brands} wholeBusiness={wholeBusiness} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function ImportDialog({ start, brands, wholeBusiness, onClose }: { start: Source; brands: Array<{ id: string; name: string }>; wholeBusiness: boolean; onClose: () => void }) {
  const router = useRouter();
  const [source, setSource] = useState<Source>(start);
  const [text, setText] = useState("");
  const [file, setFile] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Record<string, ImportField>>({});
  const [brandId, setBrandId] = useState<string>(brands.length > 1 && wholeBusiness ? "none" : (brands[0]?.id ?? "none"));
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [done, setDone] = useState<ImportDone | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const multi = brands.length > 1;

  const body = (mode: "preview" | "import", m = mapping) => ({
    mode,
    text,
    ...(file ? { file } : {}),
    ...(Object.keys(m).length ? { mapping: m } : {}),
    ...(multi ? { brandId: brandId === "none" ? null : brandId } : {}),
  });

  async function runPreview(m = mapping) {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    const r = await workCall<ImportPreview>("/import", "POST", body("preview", m));
    setBusy(false);
    if (!r.ok) {
      setPreview(null);
      return setError(workErrorText(r.data));
    }
    setPreview(r.data);
  }

  async function runImport() {
    setBusy(true);
    setError(null);
    const r = await workCall<ImportDone>("/import", "POST", body("import"));
    setBusy(false);
    if (!r.ok) return setError(workErrorText(r.data));
    setDone(r.data);
    router.refresh();
  }

  async function readFile(f: File | undefined) {
    if (!f) return;
    setFile(f.name);
    setText(await f.text());
    setPreview(null);
  }

  const pick = (head: string, field: ImportField) => {
    const next = { ...mapping, [head]: field };
    setMapping(next);
    void runPreview(next);
  };

  const missing = preview ? AFTER.filter(([f]) => !preview.columns.some((c) => c.field === f)).map(([, label]) => label) : [];
  const footer = done ? (
    <Button tone="primary" onClick={onClose}>
      Done
    </Button>
  ) : (
    <>
      {preview ? <p className="mr-auto text-xs text-neutral-500 dark:text-neutral-400">{preview.refHint}</p> : null}
      <Button onClick={onClose}>Cancel</Button>
      {preview ? (
        <Button tone="primary" disabled={busy || preview.total === 0} onClick={() => void runImport()}>
          {busy ? "Importing…" : importButton(preview.total)}
        </Button>
      ) : (
        <Button tone="primary" disabled={busy || !text.trim()} onClick={() => void runPreview()}>
          {busy ? "Reading…" : "Preview"}
        </Button>
      )}
    </>
  );

  return (
    <WorkDialog open onClose={onClose} title="Import tasks" about={WORK_COPY.importIntro} footer={footer} wide>
      {done ? (
        <div className="space-y-3">
          <p role="status" className="font-medium">
            {importedText(done.imported, done.refused.length)}
          </p>
          <RefusedRows refused={done.refused} />
        </div>
      ) : (
        <>
          <div role="tablist" aria-label="Where the rows come from" className="flex gap-1 border-b border-neutral-200 dark:border-neutral-800">
            {(
              [
                ["csv", "Upload a CSV"],
                ["paste", "Paste from Google Sheets"],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={source === k}
                onClick={() => setSource(k)}
                className={`-mb-px border-b-2 px-3 py-2 ${source === k ? "border-neutral-900 font-medium dark:border-white" : "border-transparent text-neutral-500"}`}
              >
                {l}
              </button>
            ))}
          </div>
          {source === "csv" ? (
            <label className="flex items-center gap-3 rounded-md border border-dashed border-neutral-300 p-4 dark:border-neutral-700">
              <Upload size={18} aria-hidden className="text-neutral-400" />
              <span className="flex-1">{file ? file : "A CSV file of your Backlog tab, with its header row."}</span>
              <input type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" aria-label="Choose a CSV" onChange={(e) => void readFile(e.target.files?.[0])} className="text-sm" />
            </label>
          ) : (
            <textarea
              aria-label="Rows from Google Sheets"
              rows={6}
              placeholder={WORK_COPY.pastePlaceholder}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setFile(null);
                setPreview(null);
              }}
              className={`${inputClass} font-mono text-xs`}
            />
          )}
          {multi ? (
            <label className="flex flex-wrap items-center gap-2">
              <span className="text-neutral-600 dark:text-neutral-400">Rows with no Brand column are for</span>
              <select value={brandId} onChange={(e) => setBrandId(e.target.value)} className={`${inputClass} w-auto`}>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
                {wholeBusiness ? <option value="none">Whole business</option> : null}
              </select>
            </label>
          ) : null}
          {error ? (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
              {error}
            </p>
          ) : null}
          {preview ? <PreviewView preview={preview} missing={missing} onPick={pick} busy={busy} /> : null}
        </>
      )}
    </WorkDialog>
  );
}

function RefusedRows({ refused }: { refused: ImportPreview["refused"] }) {
  if (!refused.length) return null;
  return (
    <ul className="space-y-1 text-sm text-amber-800 dark:text-amber-300">
      {refused.slice(0, 50).map((r) => (
        <li key={`${r.row}${r.problem}`}>
          Row {r.row}: {r.message}
        </li>
      ))}
    </ul>
  );
}

/** The preview: each column and the field it fills, then the rows as they would come in. */
export function PreviewView({ preview, missing, onPick, busy }: { preview: ImportPreview; missing: string[]; onPick: (head: string, field: ImportField) => void; busy: boolean }) {
  return (
    <section aria-labelledby="wk-imp-preview" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="wk-imp-preview" className="font-semibold">
          Preview
        </h3>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">{previewHint(preview.total)}</span>
      </div>
      <p className="text-neutral-600 dark:text-neutral-400">
        {WORK_COPY.importColumnsHint} {missingColumnsText(missing)}
      </p>
      <div className="flex flex-wrap gap-2">
        {preview.columns.map((c) => (
          <label key={c.head} className="flex items-center gap-1.5 rounded-md border border-neutral-200 px-2 py-1 dark:border-neutral-800">
            <span className="font-medium">{c.head || "(no header)"}</span>
            <select aria-label={`Field for the column ${c.head}`} disabled={busy} value={c.field} onChange={(e) => onPick(c.head, e.target.value as ImportField)} className="rounded border border-neutral-300 bg-white px-1 py-0.5 text-xs dark:border-neutral-700 dark:bg-neutral-950">
              {IMPORT_FIELDS.map((f) => (
                <option key={f} value={f}>
                  {IMPORT_FIELD_LABEL[f]}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {preview.unknownText ? (
        <p role="note" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {preview.unknownText}
        </p>
      ) : null}
      <div role="table" aria-label="Preview of the rows" className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
        <div role="row" className="grid grid-cols-[4rem_minmax(12rem,1fr)_9rem_6rem_8rem_8rem] gap-2 border-b border-neutral-200 bg-neutral-50 px-2 py-1.5 text-xs font-medium text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900">
          {["Ref", "Task", "Status", "Must have", "Stage", "Brand"].map((h) => (
            <span key={h} role="columnheader">
              {h}
            </span>
          ))}
        </div>
        {preview.rows.map((r) => (
          <div key={r.row} role="row" className="grid grid-cols-[4rem_minmax(12rem,1fr)_9rem_6rem_8rem_8rem] gap-2 border-b border-neutral-100 px-2 py-1.5 last:border-b-0 dark:border-neutral-900">
            <span role="cell" className="tabular-nums text-neutral-500">
              {r.ref ? `#${r.ref}` : "New"}
            </span>
            <span role="cell" className="min-w-0 truncate font-medium" title={r.description || undefined}>
              {r.title}
            </span>
            <span role="cell" className="flex flex-wrap items-center gap-1">
              <Chip tone={WORK_STATUS_TONE[r.status]}>{r.statusLabel}</Chip>
              {r.unknownStatus ? <span className="text-xs text-amber-700 dark:text-amber-300">{r.unknownStatus}?</span> : null}
            </span>
            <span role="cell">{r.mustHave ? "Yes" : ""}</span>
            <span role="cell">{r.stage ? stageLabel(r.stage) : ""}</span>
            <span role="cell" className="truncate">
              {r.brand ?? ""}
            </span>
          </div>
        ))}
      </div>
      <RefusedRows refused={preview.refused} />
    </section>
  );
}
