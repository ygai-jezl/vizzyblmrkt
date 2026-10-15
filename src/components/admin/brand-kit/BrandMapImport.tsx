"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BrandMapImport as ImportRecord } from "@/lib/types/brandMapRecords";
import type { ImportReport, ReportItem } from "@/lib/brandMap/importCompare";
import { api, errorText } from "@/components/admin/connect/api";
import { Banner, Button } from "@/components/admin/connect/ui";
import { STATE_LABEL, WriteNext } from "./BrandMapCoverage";
import { smallLabel } from "./BrandMapParts";

/**
 * Your own research, from a PDF (BRAND_MAP_IMPORT_ENABLED): upload one (a PDF only, such as
 * screenshots of Google with "People also ask" and "People also search for"); it is read,
 * placed on the map a batch at a time, and dropped. The report says, item by item, what the
 * map already answers, what is on it but not written yet, and what is new and where it would
 * go: new questions, new subjects, a new group at the top. New ones arrive ticked; "Add
 * ticked" puts them on the map. Reopened, the report follows the map.
 */

const MAP = "/api/admin/brand-kit/map";
const MAX_BYTES = 14 * 1024 * 1024;
const SMALL = "rounded border border-neutral-300 px-2 py-0.5 text-[11px] hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const SOURCE: Record<ReportItem["kind"], string> = { ask: "People also ask", also: "People also search for", question: "A question in it", theme: "A heading", note: "A finding" };

type Summary = { id: string; fileName: string; pages: number; at: string; searches: string[]; items: number; placed: boolean };
type Open = { import: ImportRecord; report: ImportReport };
type Filter = "new" | "map" | "nofit" | "searches";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

export function BrandMapImport({ canEdit, programmes }: { canEdit: boolean; programmes: Array<{ id: string; name: string }> | null }) {
  const [imports, setImports] = useState<Summary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "err" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api<{ imports?: Summary[]; error?: string }>(`${MAP}/imports`);
    setImports(r.ok && r.data.imports ? r.data.imports : []);
    if (!r.ok) setNote({ tone: "err", text: errorText(r.data) });
  }, []);
  const loadOpen = useCallback(async (id: string) => {
    const r = await api<Open & { error?: string }>(`${MAP}/imports/${encodeURIComponent(id)}`);
    if (r.ok && r.data.report) setOpen({ import: r.data.import, report: r.data.report });
    else {
      setOpen(null);
      setNote({ tone: "err", text: errorText(r.data) });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (openId) void loadOpen(openId);
    else setOpen(null);
  }, [openId, loadOpen]);

  async function upload() {
    if (!file) return;
    if (file.size > MAX_BYTES) return setNote({ tone: "err", text: errorText({ error: "pdf_too_large" }) });
    setBusy(true);
    setNote(null);
    setProgress("Reading your PDF: its text and its screenshots. This takes about a minute.");
    const form = new FormData();
    form.set("file", file);
    const res = await fetch(`${MAP}/imports`, { method: "POST", body: form }).catch(() => null);
    const body = (await res?.json().catch(() => ({}))) as { import?: { id: string }; run?: { id: string }; error?: string } | undefined;
    if (!res?.ok || !body?.import || !body.run) {
      setBusy(false);
      setProgress(null);
      setNote({ tone: "err", text: res ? errorText(body) : "The upload didn't get through. Try again." });
      return;
    }
    const id = body.import.id;
    await placeAll(id, body.run.id);
    setBusy(false);
    setProgress(null);
    setFile(null);
    await load();
    setOpenId(id);
    if (openId === id) await loadOpen(id);
  }

  /** Place what an import found, a batch per step of a run, until done or a batch fails. */
  async function placeAll(id: string, runId: string) {
    for (let batch = 1; batch <= 10; batch += 1) {
      setProgress(`Placing what it found on your map (batch ${batch})…`);
      const p = await api<{ done?: boolean; error?: string }>(`${MAP}/imports/${encodeURIComponent(id)}/place`, { method: "POST", body: JSON.stringify({ runId }) });
      if (!p.ok) {
        setNote({ tone: "err", text: `${errorText(p.data)} What was placed so far is in the report, and “Place the rest” carries on.` });
        return;
      }
      if (p.data.done) return;
    }
  }

  /** "Place the rest" of an import whose placing stopped: a new run, so one research allowance. */
  async function placeRest(id: string) {
    setBusy(true);
    setNote(null);
    const start = await api<{ run?: { id: string }; error?: string }>(`${MAP}/runs`, { method: "POST", body: JSON.stringify({ kind: "import" }) });
    if (start.ok && start.data.run) await placeAll(id, start.data.run.id);
    else setNote({ tone: "err", text: errorText(start.data) });
    setBusy(false);
    setProgress(null);
    await load();
    await loadOpen(id);
  }

  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-300">
        Bring your own research as a PDF, such as screenshots of Google with &ldquo;People also ask&rdquo; and &ldquo;People also search for&rdquo;. We read it, show what it
        adds to your map, and drop the file: only what it found is kept.
      </p>
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm">
            <span className="sr-only">A PDF of your research</span>
            <input type="file" accept="application/pdf,.pdf" disabled={busy} onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" />
          </label>
          <Button tone="primary" disabled={busy || !file} onClick={() => void upload()}>
            Read it
          </Button>
          <span className="text-[11px] text-neutral-500">A PDF only, 14 MB at most.</span>
        </div>
      ) : null}
      {progress ? (
        <p role="status" className="text-xs text-neutral-500">
          {progress}
        </p>
      ) : null}
      {note ? <Banner tone={note.tone}>{note.text}</Banner> : null}

      {open ? (
        <ImportReportView
          key={open.import.id}
          open={open}
          canEdit={canEdit}
          programmes={programmes}
          onChange={(next) => setOpen(next)}
          onPlaceRest={canEdit && !open.import.placed ? () => void placeRest(open.import.id) : null}
          placing={busy}
          onRemoved={() => {
            setOpenId(null);
            void load();
          }}
          onClose={() => setOpenId(null)}
        />
      ) : null}

      <section aria-label="Your imports" className="space-y-1.5">
        <span className={smallLabel}>Your research so far</span>
        {imports === null ? <p className="text-xs text-neutral-500">Loading…</p> : null}
        {imports && !imports.length ? <p className="text-xs text-neutral-500">Nothing yet.</p> : null}
        <ul className="space-y-1">
          {(imports ?? []).map((i) => (
            <li key={i.id}>
              <button
                type="button"
                aria-pressed={openId === i.id}
                onClick={() => setOpenId(i.id)}
                className={`flex w-full flex-wrap items-baseline gap-2 rounded-md border px-2.5 py-1.5 text-left ${openId === i.id ? "border-neutral-900 dark:border-white" : "border-neutral-200 dark:border-neutral-800"}`}
              >
                <span className="min-w-0 flex-1 break-words text-sm">{i.fileName}</span>
                <span className="text-[11px] text-neutral-500">
                  {plural(i.items, "thing")} found · {new Date(i.at).toLocaleDateString("en-GB")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function ImportReportView({
  open,
  canEdit,
  programmes,
  onChange,
  onPlaceRest,
  placing,
  onRemoved,
  onClose,
}: {
  open: Open;
  canEdit: boolean;
  programmes: Array<{ id: string; name: string }> | null;
  onChange: (next: Open) => void;
  /** Placing stopped before the end: carry on (null = it finished, or not an admin). */
  onPlaceRest: (() => void) | null;
  placing: boolean;
  onRemoved: () => void;
  onClose: () => void;
}) {
  const { import: imp, report } = open;
  const [filter, setFilter] = useState<Filter>("new");
  // New ones arrive ticked; close ones are the person's call.
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(report.items.filter((i) => i.outcome === "new" && i.addable).map((i) => i.id)));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "err" | "info"; text: string } | null>(null);
  const c = report.counts;
  const groupFor = useMemo(() => new Map(report.themes.filter((t) => t.becomesGroup).map((t) => [t.name, t.name])), [report.themes]);
  const shown = report.items.filter((i) =>
    filter === "new"
      ? i.outcome === "new" || i.outcome === "close"
      : filter === "map"
        ? i.outcome === "on_map" || i.outcome === "answered" || i.outcome === "waiting"
        : filter === "nofit"
          ? i.outcome === "no_fit"
          : i.kind === "also",
  );
  const findings = report.items.filter((i) => i.outcome === "note");
  const toAdd = report.items.filter((i) => ticked.has(i.id) && i.addable && (i.outcome === "new" || i.outcome === "close"));

  async function add() {
    setBusy(true);
    setNote(null);
    const r = await api<Partial<Open> & { added?: number; newSubjects?: number; newGroups?: number; error?: string }>(`${MAP}/imports/${encodeURIComponent(imp.id)}/add`, {
      method: "POST",
      body: JSON.stringify({ items: toAdd.map((i) => i.id) }),
    });
    setBusy(false);
    if (!r.ok) return setNote({ tone: "err", text: errorText(r.data) });
    setNote({
      tone: "ok",
      text: `Added ${plural(r.data.added ?? 0, "question")}${r.data.newSubjects ? `, ${plural(r.data.newSubjects, "new subject")}` : ""}${r.data.newGroups ? ` and ${plural(r.data.newGroups, "new group")}` : ""}. They're on your map now.`,
    });
    if (r.data.import && r.data.report) onChange({ import: r.data.import, report: r.data.report });
  }

  async function remove() {
    setBusy(true);
    const r = await api(`${MAP}/imports/${encodeURIComponent(imp.id)}`, { method: "DELETE" });
    setBusy(false);
    if (!r.ok) return setNote({ tone: "err", text: errorText(r.data) });
    onRemoved();
  }

  const stat = (n: number, label: string) => (
    <div className="min-w-[7rem] rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800">
      <div className="text-lg font-semibold">{n.toLocaleString("en")}</div>
      <div className="text-[11px] text-neutral-500">{label}</div>
    </div>
  );
  const chip = (f: Filter, label: string) => (
    <button
      key={f}
      type="button"
      aria-pressed={filter === f}
      onClick={() => setFilter(f)}
      className={`rounded-full border px-2.5 py-0.5 text-xs ${filter === f ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900" : "border-neutral-300 dark:border-neutral-700"}`}
    >
      {label}
    </button>
  );

  return (
    <section aria-label="What your research adds" className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Your research</div>
        <h3 className="text-base font-semibold">What your research adds</h3>
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          {imp.fileName}
          <span className="text-neutral-500">
            {" "}
            · {plural(imp.pages, "page")}
            {imp.searches[0] ? ` · searched for “${imp.searches[0]}”` : ""}
          </span>
        </p>
      </div>
      {note ? <Banner tone={note.tone}>{note.text}</Banner> : null}
      {onPlaceRest ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
          Placing what it found stopped before the end.
          <button type="button" disabled={placing || busy} onClick={onPlaceRest} className={SMALL}>
            Place the rest
          </button>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {stat(c.newQuestions, "new questions")}
        {stat(c.newSubjects, "new subjects")}
        {stat(c.newGroups, c.newGroups === 1 ? "new group at the top" : "new groups at the top")}
        {stat(c.onMap + c.answered + c.waiting, "already on your map")}
        {stat(c.noFit, "don't fit what you do")}
      </div>

      {report.themes.length ? (
        <div className="space-y-1">
          <span className={smallLabel}>Headings in the AI answer, and where they sit on your map</span>
          <ul className="space-y-0.5 text-sm">
            {report.themes.map((t) => (
              <li key={t.name} className="break-words">
                {t.name}
                <span className="text-xs text-neutral-500">
                  {" "}
                  →{" "}
                  {t.groupName
                    ? `${t.groupName}, your group`
                    : t.becomesGroup
                      ? `a new group, with ${plural(t.newSubjects.length, "new subject")}`
                      : t.newSubjects.length
                        ? `New: ${t.newSubjects[0]}`
                        : "nothing new under it"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        {chip("new", `New (${c.newQuestions + c.close})`)}
        {chip("map", `On your map (${c.onMap + c.answered + c.waiting})`)}
        {chip("nofit", `Doesn't fit (${c.noFit})`)}
        {chip("searches", `Searches (${c.searches})`)}
      </div>
      <ul className="space-y-1.5">
        {shown.map((i) => (
          <li key={i.id} className="flex items-start gap-2 rounded-md border border-neutral-200 px-2 py-1.5 dark:border-neutral-800">
            {i.addable && (i.outcome === "new" || i.outcome === "close") ? (
              <input
                type="checkbox"
                aria-label={`Add “${i.question}”`}
                checked={ticked.has(i.id)}
                disabled={!canEdit}
                onChange={() =>
                  setTicked((t) => {
                    const next = new Set(t);
                    if (next.has(i.id)) next.delete(i.id);
                    else next.add(i.id);
                    return next;
                  })
                }
                className="mt-1"
              />
            ) : (
              <span aria-hidden className="inline-block w-[13px]" />
            )}
            <div className="min-w-0 flex-1 space-y-0.5">
              <span className="block text-sm">{i.question || i.text}</span>
              <span className="block text-[11px] text-neutral-500">
                {i.page ? `p${i.page} · ` : ""}
                {SOURCE[i.kind]}
                {i.kind === "also" && i.question ? ` · from the search “${i.text}”` : ""}
              </span>
              <span className="block text-[11px] text-neutral-600 dark:text-neutral-300">{whereItGoes(i, groupFor)}</span>
            </div>
            {i.outcome === "on_map" && i.match?.state === "open" && programmes?.length ? <WriteNext questionId={i.match.id} programmes={programmes} /> : null}
          </li>
        ))}
        {!shown.length ? <li className="text-xs text-neutral-500">Nothing here.</li> : null}
      </ul>

      {report.adds.length ? (
        <div className="space-y-1">
          <span className={smallLabel}>People add to the search</span>
          <div className="flex flex-wrap gap-1.5">
            {report.adds.map((a) => (
              <span key={a} className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-900">
                {a}
              </span>
            ))}
          </div>
          <p className="text-[11px] text-neutral-500">Articles written for questions from this research get these as leads: they say what readers expect.</p>
        </div>
      ) : null}
      {imp.cited.length ? (
        <div className="space-y-1">
          <span className={smallLabel}>The AI answer cites</span>
          <div className="flex flex-wrap gap-1.5">
            {imp.cited.map((s) => (
              <span key={s} className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-900">
                {s}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {findings.length ? (
        <div className="space-y-1">
          <span className={smallLabel}>Findings in it</span>
          <ul className="space-y-0.5 text-sm">
            {findings.map((f) => (
              <li key={f.id}>
                {f.text}
                {f.page ? <span className="text-xs text-neutral-500"> · p{f.page}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {canEdit ? (
          <Button tone="primary" disabled={busy || !toAdd.length} onClick={() => void add()}>
            Add ticked ({toAdd.length})
          </Button>
        ) : null}
        <Button onClick={onClose}>Close</Button>
        {canEdit ? (
          <button type="button" disabled={busy} onClick={() => void remove()} className={SMALL}>
            Remove this import
          </button>
        ) : null}
        <span className="flex-1 text-right text-[11px] text-neutral-500">The PDF isn&apos;t kept. This report is, and it updates as you publish.</span>
      </div>
    </section>
  );
}

/** Where an item stands on the map, or would go, in a line. */
function whereItGoes(i: ReportItem, newGroups: Map<string, string>): string {
  switch (i.outcome) {
    case "answered":
      return `Answered: ${i.answeredBy?.title ?? i.match?.text ?? ""}`;
    case "on_map":
      return `On your map: “${i.match?.text}” · ${i.match?.subjectName} · ${i.match?.state === "open" ? "not written yet" : STATE_LABEL[i.match?.state ?? "open"].toLowerCase()}`;
    case "waiting":
      return `Proposed on your map already, waiting for you · ${i.match?.subjectName}`;
    case "close":
      return `Close to your “${i.match?.text}” · ${i.match?.subjectName}. Add it only if it's a different question.`;
    case "new":
      if (!i.addable) return "Couldn't place it on your map.";
      if (i.newSubject) return `New subject: ${i.newSubject}${i.theme && newGroups.has(i.theme) ? ` · new group “${i.theme}”` : ""}`;
      return `Your subject: ${i.subjectName}`;
    case "no_fit":
      return i.why ? `Doesn't fit what you do: ${i.why}` : "Doesn't fit what you do.";
    case "search":
      return i.adds ? `Adds “${i.adds}”` : "A search";
    default:
      return "";
  }
}
