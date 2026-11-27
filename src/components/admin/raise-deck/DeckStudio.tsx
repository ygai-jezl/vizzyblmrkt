"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/admin/email/Modal";
import { useShell } from "@/components/admin/nav/ShellProvider";
import type { DeckView } from "@/lib/raise/docs/adminApi";
import { deckChecks } from "@/lib/raise/docs/checks";
import { addSlide, dismissNeed, insertBlock, isChanged, moveSlide, needsCount, removeBlock, removeSlide, saveBody, type TextField } from "@/lib/raise/docs/edit";
import { RAISE_KIT_HREF } from "@/lib/raise/docs/paths";
import { talkSeconds, wordsOf } from "@/lib/raise/docs/text";
import { RAISE_DOC_LIMITS as L, type MetricBlock, type SectionKey, type Slide } from "@/lib/raise/docs/types";
import { EDITOR_WORDS, LIST_WORDS, RAISE_MESSAGES, STUDIO_WORDS } from "@/lib/raise/docs/words";
import { deleteDeck, exportHref, messageFor, readDeck, refreshNumbers, saveDeck } from "./api";
import { DeckFonts } from "./DeckFonts";
import { InsertNumberDialog } from "./InsertNumberDialog";
import { PresentView } from "./PresentView";
import { PrintDeck } from "./PrintDeck";
import { SideTabs } from "./SideTabs";
import { SlideEditor } from "./SlideEditor";
import { FitSlide } from "./SlideFrame";
import { SlideRail } from "./SlideRail";
import { SlideView } from "./SlideView";
import { UkReminderDialog } from "./UkReminderDialog";
import { VersionsDrawer } from "./VersionsDrawer";

const BUTTON = "rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900";
const PRIMARY = "rounded-md border border-neutral-900 bg-neutral-900 px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50 dark:border-white dark:bg-white dark:text-neutral-900";
const MENU_ITEM = "block w-full px-3 py-1.5 text-left text-sm hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-900";

export interface DeckStudioProps {
  initial: DeckView;
  /** The slide to open first, 0 based (from ?slide=n, as brand search links a slide). */
  initialSlide?: number;
  /** Vizzy can work on decks here (VIZZY_RAISE_ENABLED). */
  vizzy: boolean;
  /** Where the look comes from: Brand. */
  brandHref: string;
  /** New deck saved the outline without Vizzy's words. */
  outlineNotice?: boolean;
}

type Panel = null | "versions" | "delete" | "insert" | "look" | "more" | "pdf";
type Message = { tone: "ok" | "error"; text: string };

/**
 * The deck studio (Content › Raise kit › Deck): the slides down the left, the slide and its words in
 * the middle, This slide, Sources, Checks and Talk track on the right. Admins change it and save a
 * new version with a note; members open, present and save it as a PDF. Every change is a draft: a
 * deck is never sent or shared from here.
 */
export function DeckStudio({ initial, initialSlide = 0, vizzy, brandHref, outlineNotice = false }: DeckStudioProps) {
  const router = useRouter();
  const shell = useShell();
  const [now] = useState(() => new Date());
  const [view, setView] = useState<DeckView>(initial);
  const [title, setTitle] = useState(initial.title);
  const [slides, setSlides] = useState<Slide[]>(initial.slides);
  const [index, setIndex] = useState(() => Math.max(0, Math.min(initial.slides.length - 1, initialSlide)));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<null | "save" | "refresh" | "delete">(null);
  const [message, setMessage] = useState<Message | null>(outlineNotice ? { tone: "error", text: RAISE_MESSAGES.outlineOnly } : null);
  const [incoming, setIncoming] = useState<DeckView | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [field, setField] = useState<TextField | null>(null);
  const [ask, setAsk] = useState("");
  const [present, setPresent] = useState<null | { start: number; rehearse: boolean }>(null);
  const [printing, setPrinting] = useState(false);

  const canEdit = view.canEdit;
  const dirty = isChanged(view, { title, slides });
  const slide = slides[index] ?? slides[0]!;

  const checks = useMemo(() => deckChecks({ audience: view.audience, slides }), [view.audience, slides]);
  const talk = useMemo(() => {
    const per = slides.map((s) => wordsOf(s));
    const words = per.reduce((n, w) => n + w, 0);
    return { per, words, seconds: talkSeconds(words) };
  }, [slides]);

  const adopt = useCallback((next: DeckView) => {
    setView(next);
    setTitle(next.title);
    setSlides(next.slides);
    setIndex((i) => Math.max(0, Math.min(next.slides.length - 1, i)));
    setIncoming(null);
    setNote("");
  }, []);

  // A newer version saved elsewhere (Vizzy in the chat): show it, unless there are changes here.
  const latest = useRef({ version: view.version, dirty });
  latest.current = { version: view.version, dirty };
  const receive = useCallback(
    (next: DeckView) => {
      if (next.version <= latest.current.version) return;
      if (latest.current.dirty) setIncoming(next);
      else adopt(next);
    },
    [adopt],
  );
  // The shell refreshes the page when Vizzy saves this deck: the server's newer render arrives here.
  useEffect(() => {
    receive(initial);
  }, [initial, receive]);
  const subscribe = shell?.onCanvasSaved ?? null;
  useEffect(() => {
    if (!subscribe) return;
    return subscribe((card) => {
      if (card.kind !== "raise_deck" || card.id !== view.id) return;
      void readDeck(view.id).then((r) => {
        if (r.ok && r.data.doc) receive(r.data.doc);
      });
    });
  }, [subscribe, view.id, receive]);

  // Leaving with unsaved changes uses the browser's own prompt.
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);

  const changeSlide = (next: Slide) => setSlides((all) => all.map((s, i) => (i === index ? next : s)));

  async function save() {
    setBusy("save");
    setMessage(null);
    const r = await saveDeck(view.id, saveBody(view.version, title, slides, note));
    setBusy(null);
    if (r.ok && r.data.doc) {
      adopt(r.data.doc);
      setMessage({ tone: "ok", text: r.data.saved === false ? EDITOR_WORDS.noteSaved : STUDIO_WORDS.saved(r.data.doc.version) });
      return;
    }
    setMessage({ tone: "error", text: messageFor(r.data.error) });
  }

  async function refresh() {
    setPanel(null);
    setBusy("refresh");
    setMessage(null);
    const r = await refreshNumbers(view.id, view.version);
    setBusy(null);
    if (r.ok && r.data.doc) {
      adopt(r.data.doc);
      setMessage({ tone: "ok", text: r.data.changed?.length ? STUDIO_WORDS.refreshed(r.data.doc.version) : STUDIO_WORDS.upToDate });
      return;
    }
    setMessage({ tone: "error", text: messageFor(r.data.error) });
  }

  async function remove() {
    setBusy("delete");
    const r = await deleteDeck(view.id);
    if (r.ok) {
      router.push(RAISE_KIT_HREF);
      router.refresh();
      return;
    }
    setBusy(null);
    setPanel(null);
    setMessage({ tone: "error", text: messageFor(r.data.error) });
  }

  function insert(block: MetricBlock) {
    const next = insertBlock(slide, block, field ?? undefined);
    setPanel(null);
    if (next) changeSlide(next);
  }

  function add(section: SectionKey) {
    const next = addSlide(slides, index, section);
    if (!next) return;
    setSlides(next.slides);
    setIndex(next.index);
    setField(null);
  }

  function move(by: -1 | 1) {
    setSlides(moveSlide(slides, index, by));
    setIndex((i) => Math.max(0, Math.min(slides.length - 1, i + by)));
  }

  function removeCurrent() {
    const next = removeSlide(slides, index);
    if (!next) return;
    setSlides(next);
    setIndex((i) => Math.min(i, next.length - 1));
  }

  function sendAsk(e: React.FormEvent) {
    e.preventDefault();
    const text = ask.trim();
    if (!text || dirty || !shell) return;
    shell.ask(STUDIO_WORDS.askPrefix(index + 1, text));
    setAsk("");
  }

  const vizzyHere = vizzy && Boolean(shell);
  const savedVersion = view.versions.find((v) => v.n === view.version);
  // Present and the PDF show the slides as they are here; the footer names a version only when they are that version.
  const shownVersion = dirty ? null : { n: view.version, at: savedVersion?.at ?? view.updatedAt };
  const endPrint = useCallback(() => setPrinting(false), []);
  const closePresent = useCallback(() => setPresent(null), []);

  return (
    <div className="space-y-4">
      <DeckFonts theme={view.theme} />

      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-2">
        {canEdit ? (
          <input
            aria-label={STUDIO_WORDS.deckName}
            value={title}
            maxLength={L.title}
            onChange={(e) => setTitle(e.target.value)}
            className="min-w-[12rem] flex-1 rounded-md border border-transparent px-2 py-1 text-lg font-semibold hover:border-neutral-300 focus:border-neutral-400 dark:bg-transparent dark:hover:border-neutral-700"
          />
        ) : (
          <h1 className="min-w-[12rem] flex-1 text-lg font-semibold">{title}</h1>
        )}
        <span className="rounded-full border border-neutral-300 px-2 py-0.5 text-xs dark:border-neutral-700">{view.kindLabel}</span>
        <span className="text-xs text-neutral-500">{LIST_WORDS.row.draft(view.version)}</span>
        <div className="relative">
          <button type="button" className={BUTTON} onClick={() => setPanel(panel === "look" ? null : "look")} aria-expanded={panel === "look"}>
            {STUDIO_WORDS.look}
          </button>
          {panel === "look" ? (
            <div className="absolute right-0 top-full z-30 mt-1 w-64 space-y-2 rounded-md border border-neutral-200 bg-white p-3 text-sm shadow-lg dark:border-neutral-800 dark:bg-neutral-950">
              <p>{STUDIO_WORDS.lookLine}</p>
              <Link href={brandHref} className="font-medium text-blue-700 hover:underline dark:text-blue-300">
                {STUDIO_WORDS.openBrand}
              </Link>
            </div>
          ) : null}
        </div>
        {vizzyHere ? (
          <button type="button" className={BUTTON} onClick={() => shell?.setVizzyOpen(true)}>
            {STUDIO_WORDS.askVizzy}
          </button>
        ) : null}
        <button type="button" className={BUTTON} onClick={() => setPresent({ start: index, rehearse: false })}>
          {STUDIO_WORDS.present}
        </button>
        <button type="button" className={BUTTON} onClick={() => setPanel("pdf")}>
          {STUDIO_WORDS.savePdf}
        </button>
        <div className="relative">
          <button type="button" className={BUTTON} onClick={() => setPanel(panel === "more" ? null : "more")} aria-expanded={panel === "more"} aria-haspopup="menu">
            {STUDIO_WORDS.more}
          </button>
          {panel === "more" ? (
            <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-52 rounded-md border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-950">
              {canEdit ? (
                <button type="button" role="menuitem" className={MENU_ITEM} disabled={busy !== null || dirty} title={dirty ? STUDIO_WORDS.saveFirst : undefined} onClick={() => void refresh()}>
                  {STUDIO_WORDS.refresh}
                </button>
              ) : null}
              <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => setPanel("versions")}>
                {STUDIO_WORDS.versions}
              </button>
              {canEdit ? (
                <a role="menuitem" className={MENU_ITEM} href={exportHref(view.id)} download onClick={() => setPanel(null)}>
                  {STUDIO_WORDS.download}
                </a>
              ) : null}
              {canEdit ? (
                <button type="button" role="menuitem" className={`${MENU_ITEM} text-red-700 dark:text-red-400`} onClick={() => setPanel("delete")}>
                  {STUDIO_WORDS.delete}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {incoming ? (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <span>{STUDIO_WORDS.vizzySaved(incoming.version)}</span>
          <button type="button" className="font-medium underline" onClick={() => adopt(incoming)}>
            {STUDIO_WORDS.discardMine}
          </button>
        </div>
      ) : null}
      {message ? (
        <p role={message.tone === "error" ? "alert" : "status"} className={`text-sm ${message.tone === "error" ? "text-red-700 dark:text-red-400" : "text-green-700 dark:text-green-400"}`}>
          {message.text}
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[184px_minmax(0,1fr)_300px]">
        <div className="max-h-[80vh] overflow-y-auto">
          <SlideRail
            slides={slides}
            index={index}
            checks={checks}
            theme={view.theme}
            title={title}
            audience={view.audience}
            stage={view.stage}
            canEdit={canEdit}
            now={now}
            onSelect={(i) => {
              setIndex(i);
              setField(null);
            }}
            onAdd={add}
            onMove={move}
            onRemove={removeCurrent}
          />
        </div>

        <div className="min-w-0 space-y-4">
          <FitSlide className="overflow-hidden rounded-md border border-neutral-200 shadow-sm dark:border-neutral-800">
            <SlideView
              slide={slide}
              theme={view.theme}
              n={index + 1}
              total={slides.length}
              title={title}
              audience={view.audience}
              stage={view.stage}
              mode="edit"
              version={shownVersion}
              now={now}
              onDismissNeed={canEdit ? (id) => changeSlide(dismissNeed(slide, id)) : undefined}
            />
          </FitSlide>

          <SlideEditor
            slide={slide}
            n={index + 1}
            stage={view.stage}
            canEdit={canEdit}
            now={now}
            onChange={changeSlide}
            onFocusField={setField}
            onRemoveBlock={(id) => changeSlide(removeBlock(slide, id))}
            onInsertNumber={() => setPanel("insert")}
          />

          {canEdit && dirty ? (
            <div className="flex flex-wrap items-end gap-2 rounded-md border border-neutral-300 p-3 dark:border-neutral-700">
              <label className="min-w-[12rem] flex-1 text-xs">
                {STUDIO_WORDS.whatChanged}
                <input value={note} maxLength={L.note} onChange={(e) => setNote(e.target.value)} className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900" />
              </label>
              <button type="button" className={PRIMARY} disabled={busy !== null} onClick={() => void save()}>
                {busy === "save" ? EDITOR_WORDS.saving : STUDIO_WORDS.save}
              </button>
            </div>
          ) : null}

          {canEdit && view.canDraft && vizzyHere ? (
            <form onSubmit={sendAsk} className="space-y-1">
              <label htmlFor="rd-ask" className="block text-xs font-medium text-neutral-600 dark:text-neutral-400">
                {STUDIO_WORDS.ask}
              </label>
              <div className="flex gap-2">
                <input
                  id="rd-ask"
                  value={ask}
                  maxLength={500}
                  disabled={dirty}
                  onChange={(e) => setAsk(e.target.value)}
                  placeholder={STUDIO_WORDS.askPlaceholder}
                  className="flex-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
                />
                <button type="submit" className={BUTTON} disabled={dirty || !ask.trim()}>
                  {STUDIO_WORDS.askVizzy}
                </button>
              </div>
              {dirty ? <p className="text-xs text-neutral-500">{STUDIO_WORDS.saveFirst}</p> : null}
            </form>
          ) : null}
        </div>

        <aside className="min-w-0">
          <SideTabs
            key={slide.id}
            slide={slide}
            audience={view.audience}
            checks={checks}
            sources={view.sources}
            talk={{ slide: { words: talk.per[index] ?? 0, seconds: talkSeconds(talk.per[index] ?? 0) }, deck: { words: talk.words, seconds: talk.seconds } }}
            now={now}
            onRehearse={() => setPresent({ start: index, rehearse: true })}
          />
        </aside>
      </div>

      <InsertNumberDialog key={`${slide.id}-${panel === "insert"}`} open={panel === "insert"} options={view.numberOptions} onClose={() => setPanel(null)} onInsert={insert} />
      <VersionsDrawer
        open={panel === "versions"}
        onClose={() => setPanel(null)}
        deckId={view.id}
        versions={view.versions}
        version={view.version}
        canEdit={canEdit}
        theme={view.theme}
        audience={view.audience}
        stage={view.stage}
        now={now}
        dirty={dirty}
        onRestored={(doc) => {
          setPanel(null);
          adopt(doc);
          setMessage({ tone: "ok", text: STUDIO_WORDS.saved(doc.version) });
        }}
      />
      <UkReminderDialog
        open={panel === "pdf"}
        audience={view.audience}
        needs={needsCount(slides)}
        onCancel={() => setPanel(null)}
        onSave={() => {
          setPanel(null);
          setPrinting(true);
        }}
      />
      {printing ? <PrintDeck slides={slides} theme={view.theme} title={title} audience={view.audience} stage={view.stage} version={shownVersion} now={now} onDone={endPrint} /> : null}
      {present ? (
        <PresentView
          slides={slides}
          theme={view.theme}
          title={title}
          audience={view.audience}
          stage={view.stage}
          version={shownVersion}
          perSlideSeconds={talk.per.map((w) => talkSeconds(w))}
          start={present.start}
          rehearse={present.rehearse}
          onClose={closePresent}
        />
      ) : null}
      <Modal open={panel === "delete"} onClose={() => setPanel(null)} title={STUDIO_WORDS.delete}>
        <p className="text-sm">{STUDIO_WORDS.deleteConfirm}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={BUTTON} onClick={() => setPanel(null)}>
            {STUDIO_WORDS.cancel}
          </button>
          <button type="button" className="rounded-md border border-red-700 bg-red-700 px-3 py-1.5 text-sm text-white disabled:opacity-50" disabled={busy === "delete"} onClick={() => void remove()}>
            {STUDIO_WORDS.delete}
          </button>
        </div>
      </Modal>
    </div>
  );
}
