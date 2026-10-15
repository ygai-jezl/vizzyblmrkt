"use client";

import { useState } from "react";
import { SITUATION_W_LABEL, type BrandMapSituation } from "@/lib/types/brandMapRecords";
import type { PlacedQuestion } from "@/lib/brandMap/situationQuestions";
import { api, errorText } from "@/components/admin/connect/api";
import { Banner, Button } from "@/components/admin/connect/ui";

/**
 * "Find buying situations" (BRAND_MAP_SITUATIONS_ENABLED): research in short steps the browser
 * drives, under one research allowance. Step 1 finds the situations people are in; step 2,
 * three at a time, what people in each ask and where each question would go. Then a person
 * ticks what goes on the map (one nothing of theirs backs arrives unticked). "Add ticked"
 * adds the ticked situations with their questions on subjects already on the map; questions
 * on new subjects wait with their subject on the Subjects tab. "Dismiss the rest" turns down
 * the unticked, so research doesn't bring them back.
 */

const MAP = "/api/admin/brand-kit/map";
const SMALL = "rounded border border-neutral-300 px-2 py-0.5 text-[11px] hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const ASK_AT_ONCE = 3;

type Found = BrandMapSituation & { questions: PlacedQuestion[] | null; failed?: boolean };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function BrandMapFindSituations({ brandName, onChanged, onClose }: { brandName: string; onChanged: () => void; onClose: () => void }) {
  const [customers, setCustomers] = useState("");
  const [phase, setPhase] = useState<"ask" | "running" | "review" | "done">("ask");
  const [progress, setProgress] = useState<string | null>(null);
  const [found, setFound] = useState<Found[]>([]);
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState<string[]>([]);
  const [note, setNote] = useState<{ tone: "ok" | "err" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setPhase("running");
    setNote(null);
    setProgress("Starting…");
    const start = await api<{ run?: { id: string }; error?: string }>(`${MAP}/runs`, { method: "POST", body: JSON.stringify({ kind: "situations" }) });
    if (!start.ok || !start.data.run) {
      setPhase("ask");
      setNote({ tone: "err", text: errorText(start.data) });
      return;
    }
    const runId = start.data.run.id;
    setProgress("Finding the situations people are in. This takes about a minute.");
    const r = await api<{ found?: BrandMapSituation[]; skipped?: number; notes?: string[]; error?: string }>(`${MAP}/situations/find`, {
      method: "POST",
      body: JSON.stringify({ runId, ...(customers.trim() ? { customers: customers.trim() } : {}) }),
    });
    if (!r.ok || !r.data.found) {
      setPhase("ask");
      setNote({ tone: "err", text: r.status === 0 ? "Research may still be finishing. Look at the Proposed situations in a minute." : errorText(r.data) });
      return;
    }
    const list: Found[] = r.data.found.map((s) => ({ ...s, questions: null }));
    setFound(list);
    setNotes(r.data.notes ?? []);
    // One nothing of the brand's own backs arrives unticked.
    setUnticked(new Set(list.filter((s) => !s.backed).map((s) => s.id)));
    onChanged();
    if (!list.length) {
      setProgress(null);
      setPhase("review");
      setNote({ tone: "info", text: r.data.skipped ? "Research found only situations you already have or turned down." : "Research found nothing new this time." });
      return;
    }
    let asked = 0;
    for (let i = 0; i < list.length; i += ASK_AT_ONCE) {
      setProgress(`Finding what people in them ask (${asked} of ${list.length})…`);
      await Promise.all(
        list.slice(i, i + ASK_AT_ONCE).map(async (s) => {
          const q = await api<{ questions?: PlacedQuestion[]; error?: string }>(`${MAP}/situations/${encodeURIComponent(s.id)}/questions`, {
            method: "POST",
            body: JSON.stringify({ runId }),
          });
          setFound((prev) => prev.map((f) => (f.id === s.id ? { ...f, questions: q.ok ? (q.data.questions ?? []) : [], failed: !q.ok } : f)));
          asked += 1;
        }),
      );
    }
    setProgress(null);
    setPhase("review");
  }

  async function decide(add: boolean) {
    const ticked = found.filter((s) => !unticked.has(s.id));
    const rest = found.filter((s) => unticked.has(s.id));
    setBusy(true);
    setNote(null);
    if (add) {
      // Questions on subjects already on the map go on with their situation; ones on new subjects wait with them.
      const questions = ticked.flatMap((s) => (s.questions ?? []).filter((q) => q.status === "proposed" && !q.newSubject).map((q) => q.id));
      const newSubjects = new Set(ticked.flatMap((s) => (s.questions ?? []).filter((q) => q.status === "proposed" && q.newSubject).map((q) => q.subjectId))).size;
      const r = await api(`${MAP}/proposals`, { method: "POST", body: JSON.stringify({ accept: { situations: ticked.map((s) => s.id), questions } }) });
      setBusy(false);
      if (!r.ok) return setNote({ tone: "err", text: errorText(r.data) });
      setFound(rest);
      setNote({
        tone: "ok",
        text: `${plural(ticked.length, "situation")} and ${plural(questions.length, "question")} added.${newSubjects ? ` ${plural(newSubjects, "new subject")} ${newSubjects === 1 ? "is" : "are"} waiting on the Subjects tab.` : ""}`,
      });
    } else {
      const questions = rest.flatMap((s) => (s.questions ?? []).filter((q) => q.status === "proposed" && !q.linked).map((q) => q.id));
      const r = await api(`${MAP}/proposals`, { method: "POST", body: JSON.stringify({ dismiss: { situations: rest.map((s) => s.id), questions } }) });
      setBusy(false);
      if (!r.ok) return setNote({ tone: "err", text: errorText(r.data) });
      setFound(ticked);
      setNote({ tone: "ok", text: `${plural(rest.length, "situation")} turned down. Research won't bring ${rest.length === 1 ? "it" : "them"} back.` });
    }
    onChanged();
    if ((add ? rest : ticked).length === 0) setPhase("done");
  }

  const ticked = found.filter((s) => !unticked.has(s.id));
  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  return (
    <section aria-label="Find buying situations" className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div>
        <h3 className="text-base font-semibold">Find buying situations</h3>
        <p className="text-sm text-neutral-600 dark:text-neutral-300">The moments that send people looking for something like {brandName || "you"}, and what they ask then.</p>
      </div>
      {phase === "ask" ? (
        <>
          <label className="block space-y-1 text-xs">
            <span className="font-medium text-neutral-600 dark:text-neutral-300">
              What made your last few customers start looking? <span className="font-normal text-neutral-500">Optional</span>
            </span>
            <textarea
              value={customers}
              onChange={(e) => setCustomers(e.target.value)}
              maxLength={300}
              rows={2}
              placeholder="Two said their Google traffic fell after AI Overviews came in. One CEO asked what ChatGPT says about them."
              className="w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <p className="text-[11px] text-neutral-500">Research also reads your site, your knowledge and your articles, plus forums, reviews and what people search.</p>
          <div className="flex gap-2">
            <Button tone="primary" onClick={() => void run()}>
              Find them
            </Button>
            <Button onClick={onClose}>Cancel</Button>
          </div>
        </>
      ) : null}
      {progress ? (
        <p role="status" className="text-xs text-neutral-500">
          {progress}
        </p>
      ) : null}
      {note ? <Banner tone={note.tone}>{note.text}</Banner> : null}
      {notes.length && phase !== "done" ? (
        <ul className="space-y-0.5 text-xs text-neutral-500">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}

      {(phase === "running" || phase === "review") && found.length ? (
        <>
          <p className="text-sm text-neutral-600 dark:text-neutral-300">Ticked ones go on your map. Nothing changes until you add them.</p>
          <ul className="space-y-2">
            {found.map((s) => {
              const open = shown.has(s.id);
              return (
                <li key={s.id} className="space-y-1 rounded-md border border-neutral-200 p-2 dark:border-neutral-800">
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      aria-label={`Add “${s.text}”`}
                      checked={!unticked.has(s.id)}
                      onChange={() => setUnticked((u) => toggle(u, s.id))}
                      className="mt-1"
                    />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <span className="block text-sm font-medium">“{s.text}”</span>
                      <span className="block text-[11px] text-neutral-500">
                        {[s.who, s.side === "professional" ? "Professional" : "Business", s.wText ? `${SITUATION_W_LABEL[s.w]}: ${s.wText}` : ""].filter(Boolean).join(" · ")}
                      </span>
                      <span className={`block text-[11px] ${s.backed ? "text-neutral-500" : "text-amber-700 dark:text-amber-400"}`}>
                        {s.backed ? `Backed by ${s.backedBy.map((b) => b.label).join(", ")}` : "Not backed by your site or knowledge"}
                        {s.seen.length ? ` · seen on ${s.seen.map((w) => w.domain).join(", ")}` : ""}
                      </span>
                    </div>
                    <button
                      type="button"
                      aria-expanded={open}
                      disabled={!s.questions}
                      onClick={() => setShown((v) => toggle(v, s.id))}
                      className={SMALL}
                    >
                      {s.questions === null ? "Finding questions…" : s.failed ? "No questions this time" : `See them (${s.questions.length})`}
                    </button>
                  </div>
                  {open && s.questions ? (
                    <ul className="space-y-1 pl-6">
                      {s.questions.map((q) => (
                        <li key={q.id} className="text-xs">
                          <span className="block">{q.text}</span>
                          <span className="text-[11px] text-neutral-500">
                            {q.linked ? `On your map already: ${q.subjectName}` : q.newSubject ? `New subject: ${q.subjectName}` : `→ ${q.subjectName}`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {phase === "review" ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button tone="primary" disabled={busy || !ticked.length} onClick={() => void decide(true)}>
                Add ticked ({ticked.length})
              </Button>
              <Button disabled={busy || ticked.length === found.length} onClick={() => void decide(false)}>
                Dismiss the rest
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      {phase === "review" || phase === "done" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex-1 text-[11px] text-neutral-500">Run it again later to find more. It skips what you already have or dismissed.</span>
          <Button onClick={onClose}>Close</Button>
        </div>
      ) : null}
    </section>
  );
}
