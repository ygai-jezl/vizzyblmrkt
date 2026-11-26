"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Clock, Info, MoreHorizontal, Pause, ThumbsUp, TrendingUp, Undo2 } from "lucide-react";
import type { LearnedCardView, LookRowView } from "@/lib/loops/learnedView";
import {
  EDIT_HELPER,
  FORGET_DONE,
  FORGET_OFFER,
  FORGET_UNDONE_DONE,
  KEPT_DONE,
  backToLine,
  forgetConfirm,
  forgetUndoneConfirm,
  undoDoneLine,
} from "@/lib/loops/learnedWords";
import { LOOK_REFUSED_MESSAGE } from "@/lib/loops/textCheck";
import { ImageStyleSwatch } from "./ImageStyleSwatch";
import { learnedAction, learnedRead } from "./learnedClient";
import type { ImageStyleId } from "@/lib/types/imageStyle";

/**
 * Brand › Image style, What it learned (learning loops step 4, screen 1): below the Image style
 * card, a row per painted style the brand uses, each with its look's words, where it came from, how
 * its images did and its check, and the brand's look while a style has none of its own. Admins act:
 * Undo, and in a row's More menu Edit the words, Forget and History; Pause image learning in the
 * card's More menu. Members read, with one line saying so. The server builds every word
 * (learnedCardView); after a click the card says what it did and reads itself again.
 */

type Busy = string | null;
interface Done {
  text: string;
  /** Undo's done line offers to forget the look it left. */
  offerForget: boolean;
}

const BTN = "inline-flex items-center gap-1 rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900";
const PRIMARY = "rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50";
const MENU = "absolute right-0 z-10 mt-1 min-w-[11rem] rounded-md border border-neutral-200 bg-white p-1 text-sm shadow-md dark:border-neutral-800 dark:bg-neutral-950";
const ITEM = "block w-full rounded px-2 py-1.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900";

const CHIP_TONE: Record<LearnedCardView["chip"]["tone"], string> = {
  green: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200",
  amber: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  neutral: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200",
};

/** A menu that closes on a click elsewhere or on Escape. */
function useMenu(): { open: boolean; toggle: () => void; close: () => void; ref: React.RefObject<HTMLDivElement> } {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return { open, toggle: () => setOpen((o) => !o), close: () => setOpen(false), ref };
}

export function WhatItLearnedCard({ initial }: { initial: LearnedCardView }) {
  const [view, setView] = useState<LearnedCardView>(initial);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, Done>>({});
  const [forget, setForget] = useState<{ scope: string; title: string; body: string; also: string | null; undone: boolean } | null>(null);
  const [alsoBrand, setAlsoBrand] = useState(false);
  const menu = useMenu();
  const admin = view.role === "admin";

  async function reload() {
    const r = await learnedRead<LearnedCardView>("");
    if (r.ok) setView(r.data);
  }

  async function act<T>(key: string, body: Record<string, unknown>): Promise<(T & { ok?: boolean }) | null> {
    setBusy(key);
    setError(null);
    const r = await learnedAction<T>(body);
    setBusy(null);
    if (!r.ok) {
      setError(r.data.message ?? (r.status === 403 ? "Only admins can change what was learned." : "Couldn't change it. Try again."));
      return null;
    }
    return r.data;
  }

  async function undo(row: LookRowView) {
    const r = await act<{ restored?: number; restoredAt?: string | null; wasPerson?: boolean }>(`undo:${row.scope}`, { op: "undo", scope: row.scope });
    if (!r) return;
    const text = undoDoneLine({
      scope: row.scope,
      restored: r.restored ?? 0,
      restoredAt: r.restoredAt,
      wasPerson: r.wasPerson === true,
      brandLook: view.brandLook,
      usingBrand: view.usingBrand,
    });
    setDone((d) => ({ ...d, [row.scope]: { text, offerForget: admin } }));
    await reload();
  }

  async function openForget(row: LookRowView, undone: boolean) {
    menu.close();
    if (undone) {
      setForget({ scope: row.scope, ...forgetUndoneConfirm(row.scope), undone: true });
      return;
    }
    const r = await act<{ liked: number; disliked: number; uploaded?: number; brandOverlap: number }>(`preview:${row.scope}`, { op: "forget_preview", scope: row.scope });
    if (!r) return;
    const c = forgetConfirm({ scope: row.scope, liked: r.liked, disliked: r.disliked, uploaded: r.uploaded, brandOverlap: r.brandOverlap });
    setAlsoBrand(false);
    setForget({ scope: row.scope, ...c, undone: false });
  }

  async function confirmForget() {
    if (!forget) return;
    const f = forget;
    const r = f.undone
      ? await act(`forget:${f.scope}`, { op: "forget_undone", scope: f.scope })
      : await act(`forget:${f.scope}`, { op: "forget", scope: f.scope, ...(alsoBrand ? { alsoBrand: true } : {}) });
    setForget(null);
    if (!r) return;
    setDone((d) => ({ ...d, [f.scope]: { text: f.undone ? FORGET_UNDONE_DONE : FORGET_DONE, offerForget: false } }));
    await reload();
  }

  async function pause(paused: boolean) {
    menu.close();
    if (await act("pause", { op: paused ? "pause" : "resume" })) await reload();
  }

  async function resumeSuggestions() {
    if (await act("suggestions", { op: "resume_suggestions" })) await reload();
  }

  async function answer(row: LookRowView, op: "go_back" | "keep") {
    const r = await act<{ restored?: number; restoredAt?: string | null }>(`${op}:${row.scope}`, { op, target: { scope: row.scope } });
    if (!r) return;
    setDone((d) => ({ ...d, [row.scope]: { text: op === "keep" ? KEPT_DONE : backToLine(r.restored ?? 0, r.restoredAt), offerForget: false } }));
    await reload();
  }

  return (
    <section id="learned" aria-labelledby="learned-h" className="scroll-mt-16 space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="learned-h" className="text-sm font-semibold">
              What it learned
            </h2>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${CHIP_TONE[view.chip.tone]}`}>{view.chip.text}</span>
          </div>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">{view.lead}</p>
        </div>
        {view.canMenu ? (
          <div ref={menu.ref} className="relative">
            <button type="button" aria-label="More for What it learned" aria-haspopup="menu" aria-expanded={menu.open} onClick={menu.toggle} className="rounded-md p-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-900">
              <MoreHorizontal size={16} aria-hidden />
            </button>
            {menu.open ? (
              <div role="menu" aria-label="What it learned" className={MENU}>
                <button type="button" role="menuitem" disabled={busy !== null} onClick={() => void pause(!view.paused)} className={`${ITEM} flex items-center gap-2`}>
                  <Pause size={14} aria-hidden /> {view.paused ? "Resume image learning" : "Pause image learning"}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {view.notes.map((n) => (
        <div
          key={n.id}
          role="status"
          className={`flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm ${
            n.tone === "warn" ? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100" : "border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900"
          }`}
        >
          <span className="flex items-start gap-2">
            {n.tone === "warn" ? <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden /> : n.id === "paused" ? <Pause size={14} className="mt-1 shrink-0" aria-hidden /> : <Info size={16} className="mt-0.5 shrink-0" aria-hidden />}
            <span>{n.text}</span>
          </span>
          {n.action ? (
            <button type="button" disabled={busy !== null} onClick={() => void (n.action === "resume" ? pause(false) : resumeSuggestions())} className={BTN}>
              {n.action === "resume" ? "Resume" : "Resume suggestions"}
            </button>
          ) : null}
        </div>
      ))}

      {view.empty ? (
        <div className="flex items-start gap-3 rounded-md border border-dashed border-neutral-300 p-4 text-sm text-neutral-700 dark:border-neutral-700 dark:text-neutral-300">
          <ThumbsUp size={18} className="mt-0.5 shrink-0" aria-hidden />
          <p>{view.empty}</p>
        </div>
      ) : null}

      {view.rows.length ? (
        <div className="divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {view.rows.map((row) => (
            <LookRow
              key={row.scope}
              row={row}
              admin={admin}
              busy={busy}
              done={done[row.scope] ?? null}
              onUndo={() => void undo(row)}
              onForget={(undone) => void openForget(row, undone)}
              onEdit={async (text) => {
                const r = await learnedAction<{ v?: number }>({ op: "edit", scope: row.scope, text });
                if (!r.ok) return r.data.error === "text_refused" ? (r.data.message ?? LOOK_REFUSED_MESSAGE) : (r.data.message ?? "Couldn't save the words. Try again.");
                setDone((d) => ({ ...d, [row.scope]: { text: "", offerForget: false } }));
                await reload();
                return null;
              }}
              onAnswer={(op) => void answer(row, op)}
            />
          ))}
        </div>
      ) : null}

      {error ? <p className="text-sm text-red-700 dark:text-red-300">{error}</p> : null}
      {view.member ? <p className="text-sm text-neutral-600 dark:text-neutral-400">{view.member}</p> : null}

      {view.footer.length ? (
        <div className="space-y-1 border-t border-neutral-200 pt-3 text-xs text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
          {view.footer.map((f) => (
            <p key={f.text}>
              {f.text}
              {f.link ? (
                <>
                  {" "}
                  <Link href={f.link.href} className="font-medium text-blue-700 underline-offset-2 hover:underline dark:text-blue-300">
                    {f.link.label}
                  </Link>
                </>
              ) : null}
            </p>
          ))}
        </div>
      ) : null}

      {forget ? (
        <div role="dialog" aria-modal="true" aria-labelledby="forget-h" className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
          <div className="w-full max-w-md space-y-3 rounded-lg bg-white p-4 shadow-lg dark:bg-neutral-950">
            <h3 id="forget-h" className="text-base font-semibold">
              {forget.title}
            </h3>
            <p className="text-sm text-neutral-700 dark:text-neutral-300">{forget.body}</p>
            {forget.also ? (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={alsoBrand} onChange={(e) => setAlsoBrand(e.target.checked)} className="mt-0.5" />
                <span>{forget.also}</span>
              </label>
            ) : null}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setForget(null)} className={BTN}>
                Cancel
              </button>
              <button type="button" disabled={busy !== null} onClick={() => void confirmForget()} className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                Forget
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

const CHECK_ICON = { good: TrendingUp, bad: AlertTriangle, wait: Clock } as const;
const CHECK_TONE = {
  good: "text-green-800 dark:text-green-300",
  bad: "text-red-800 dark:text-red-300",
  wait: "text-neutral-700 dark:text-neutral-300",
} as const;

function LookRow({
  row,
  admin,
  busy,
  done,
  onUndo,
  onForget,
  onEdit,
  onAnswer,
}: {
  row: LookRowView;
  admin: boolean;
  busy: Busy;
  done: Done | null;
  onUndo: () => void;
  onForget: (undone: boolean) => void;
  onEdit: (text: string) => Promise<string | null>;
  onAnswer: (op: "go_back" | "keep") => void;
}) {
  const menu = useMenu();
  const [history, setHistory] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.words ?? "");
  const [refused, setRefused] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canAct = admin && row.hasLook;
  const CheckIcon = row.check ? CHECK_ICON[row.check.tone] : null;

  async function save() {
    setSaving(true);
    const refusal = await onEdit(draft.trim() || row.words || "");
    setSaving(false);
    if (refusal) setRefused(refusal);
    else {
      setRefused(null);
      setEditing(false);
    }
  }

  return (
    <div className="space-y-2 p-3">
      <div className="flex items-start gap-3">
        {row.styleId ? (
          <ImageStyleSwatch id={row.styleId as ImageStyleId} className="h-9 w-12 shrink-0 rounded" />
        ) : (
          <span aria-hidden className="grid h-9 w-12 shrink-0 place-items-center rounded bg-neutral-100 text-sm font-semibold text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
            B
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {row.name}
            {row.tag ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">{row.tag}</span> : null}
          </h3>
          <p className="text-xs text-neutral-600 dark:text-neutral-400">{row.status}</p>
        </div>
        {canAct ? (
          <div ref={menu.ref} className="relative flex items-center gap-1">
            {done?.offerForget ? null : (
              <button type="button" disabled={busy !== null} onClick={onUndo} className={BTN}>
                <Undo2 size={14} aria-hidden /> Undo
              </button>
            )}
            <button type="button" aria-label={`More for ${row.name}`} aria-haspopup="menu" aria-expanded={menu.open} onClick={menu.toggle} className="rounded-md p-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-900">
              <MoreHorizontal size={16} aria-hidden />
            </button>
            {menu.open ? (
              <div role="menu" aria-label={row.name} className={`${MENU} top-full`}>
                <button
                  type="button"
                  role="menuitem"
                  className={ITEM}
                  onClick={() => {
                    menu.close();
                    setDraft(row.words ?? "");
                    setRefused(null);
                    setEditing(true);
                  }}
                >
                  Edit the words
                </button>
                <button type="button" role="menuitem" className={`${ITEM} text-red-700 dark:text-red-300`} onClick={() => onForget(false)}>
                  Forget
                </button>
                {row.history.length >= 2 ? (
                  <button
                    type="button"
                    role="menuitem"
                    className={ITEM}
                    onClick={() => {
                      menu.close();
                      setHistory((h) => !h);
                    }}
                  >
                    {history ? "Hide history" : "History"}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="space-y-1.5 pl-[3.75rem] text-sm">
        {editing ? (
          <div className="space-y-2">
            <label htmlFor={`edit-${row.scope}`} className="block text-xs text-neutral-600 dark:text-neutral-400">
              {EDIT_HELPER}
            </label>
            <textarea
              id={`edit-${row.scope}`}
              rows={3}
              maxLength={2000}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setRefused(null);
              }}
              className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
            {refused ? (
              <p role="alert" className="flex items-start gap-1.5 text-xs text-red-700 dark:text-red-300">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
                <span>{refused}</span>
              </p>
            ) : null}
            <div className="flex gap-2">
              <button type="button" disabled={saving} onClick={() => void save()} className={PRIMARY}>
                Save as set by you
              </button>
              <button type="button" onClick={() => setEditing(false)} className={BTN}>
                Cancel
              </button>
            </div>
          </div>
        ) : row.words ? (
          <p className="rounded-md bg-neutral-50 px-2 py-1.5 italic text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">&ldquo;{row.words}&rdquo;</p>
        ) : null}
        {row.pending ? (
          <p className="flex items-center gap-2 text-neutral-700 dark:text-neutral-300">
            <span aria-hidden className="flex gap-1">
              {[1, 2, 3].map((n) => (
                <span key={n} className={`h-2 w-2 rounded-full ${n <= row.pending!.have ? "bg-blue-600" : "bg-neutral-300 dark:bg-neutral-700"}`} />
              ))}
            </span>
            <span>{row.pending.text}</span>
          </p>
        ) : null}
        {row.from ? (
          <div className="flex items-center gap-2 text-neutral-700 dark:text-neutral-300">
            {row.thumbs.length ? (
              <span className="flex -space-x-1.5">
                {row.thumbs.map((t) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={t.id} src={t.url} alt={t.alt} className="h-7 w-7 rounded border-2 border-white object-cover dark:border-neutral-950" />
                ))}
              </span>
            ) : null}
            <span>{row.from}</span>
          </div>
        ) : null}
        {row.lines.map((l) => (
          <p key={l} className="text-neutral-700 dark:text-neutral-300">
            {l}
          </p>
        ))}
        {row.check && CheckIcon ? (
          <p className={`flex items-start gap-1.5 ${CHECK_TONE[row.check.tone]}`}>
            <CheckIcon size={14} className="mt-1 shrink-0" aria-hidden />
            <span>{row.check.text}</span>
          </p>
        ) : null}
        {row.goBack ? (
          <p className="flex flex-wrap items-center gap-2 rounded-md bg-amber-50 px-2 py-1.5 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100">
            <span>{row.goBack.text}</span>
            <Link href={row.goBack.href} className="font-medium underline underline-offset-2">
              Open in Review
            </Link>
          </p>
        ) : null}
        {row.notice && admin ? (
          <div className="flex gap-2">
            <button type="button" disabled={busy !== null} onClick={() => onAnswer("go_back")} className={PRIMARY}>
              Go back
            </button>
            <button type="button" disabled={busy !== null} onClick={() => onAnswer("keep")} className={BTN}>
              Keep this look
            </button>
          </div>
        ) : null}
        {history && row.history.length >= 2 ? (
          <div role="list" aria-label={`History of ${row.name}`} className="space-y-1 rounded-md border border-neutral-200 p-2 text-xs dark:border-neutral-800">
            <p className="flex items-center justify-between font-medium">
              <span>History</span>
              <button type="button" onClick={() => setHistory(false)} className="text-neutral-600 underline underline-offset-2 dark:text-neutral-400">
                Hide
              </button>
            </p>
            {row.history.map((h) => (
              <p key={h.v} role="listitem" className={h.now ? "font-medium text-neutral-900 dark:text-neutral-100" : "text-neutral-700 dark:text-neutral-300"}>
                {h.text}
              </p>
            ))}
          </div>
        ) : null}
        {done?.text ? (
          <p role="status" className="flex flex-wrap items-center gap-2 text-neutral-700 dark:text-neutral-300">
            <span>{done.text}</span>
            {done.offerForget ? (
              <button type="button" onClick={() => onForget(true)} className="font-medium underline underline-offset-2">
                {FORGET_OFFER}
              </button>
            ) : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}
