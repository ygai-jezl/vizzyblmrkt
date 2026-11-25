"use client";

import { useCallback, useEffect, useState, type ComponentType } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Calendar, Check, ChevronDown, Clock, Flag, Signpost, Target, Trash2, X, type LucideProps } from "lucide-react";
import { useThemePortalContainer } from "@/components/admin/nav/AdminThemeRoot";
import { FACT_KIND_LABEL, QUESTIONS, answerLabel, type FactKind, type ProfileQuestion } from "@/lib/onboarding/choices";
import {
  BASICS_WORDS,
  DELETE_CONVERSATION_WORDS,
  FACT_WORDS,
  TRANSCRIPT_WORDS,
  longLength,
  messageCount,
  shortDate,
} from "@/lib/onboarding/words";
import type { ProfileAnswers, ProfileKey } from "@/lib/types/businessProfile";
import type { ConversationSource } from "@/lib/types/onboarding";

/**
 * The pieces Here's what I learned and Settings, About your business share: the four answers as
 * chips, the facts Vizzy heard with the member's own words, and the two conversation dialogs.
 * Theme tokens and the app's palette only, so light and dark follow the admin's choice.
 */

// ---- The four answers ------------------------------------------------------------------------

const CHIP =
  "inline-flex max-w-full items-center gap-1.5 rounded-full border bg-shell-page py-[5px] pl-3 pr-2 text-sm font-medium text-shell-ink outline-none hover:border-shell-ink focus-visible:ring-2 focus-visible:ring-shell-accent data-[state=open]:border-shell-ink";

/** One answer's chip and its menu of three choices. */
function AnswerMenu({ q, value, onPick }: { q: ProfileQuestion; value: string | undefined; onPick: (key: ProfileKey, value: string) => void }) {
  const container = useThemePortalContainer();
  const label = answerLabel(q.key, value);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label={label ? BASICS_WORDS.change(q.short, label) : BASICS_WORDS.notPickedAria(q.short)}
        className={`${CHIP} ${label ? "border-shell-line" : "border-dashed border-shell-faint text-shell-muted"}`}
      >
        <span className="truncate">{label || BASICS_WORDS.notPicked}</span>
        <ChevronDown size={14} aria-hidden className="shrink-0 text-shell-faint" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={container}>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          aria-label={q.short}
          className="z-50 w-[320px] max-w-[calc(100vw-32px)] rounded-lg border border-shell-line bg-shell-raised p-1 text-shell-ink shadow-lg"
        >
          <DropdownMenu.RadioGroup value={value ?? ""} onValueChange={(v) => onPick(q.key, v)}>
            {q.options.map((o) => (
              <DropdownMenu.RadioItem
                key={o.key}
                value={o.key}
                className="flex w-full cursor-default items-center justify-between gap-2 rounded-md px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-shell-active data-[state=checked]:font-medium"
              >
                {o.label}
                <DropdownMenu.ItemIndicator>
                  <Check size={14} aria-hidden className="text-shell-accent" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** An answer that can't be changed here: the same chip, without its menu. */
function AnswerChip({ q, value }: { q: ProfileQuestion; value: string | undefined }) {
  const label = answerLabel(q.key, value);
  return (
    <span className={`${CHIP} pr-3 ${label ? "border-shell-line" : "border-dashed border-shell-faint text-shell-muted"}`}>
      <span className="truncate">{label || BASICS_WORDS.notPicked}</span>
    </span>
  );
}

/**
 * The four answers, one row each, with a chip that opens its choices. An unanswered row asks:
 * on Learned (`blank="unsure"`) as "Not sure yet" with the member's unclear words and the three
 * choices; in Settings (`blank="notPicked"`) as a "Not picked" chip with the same menu.
 * `readOnly` shows the chips without their menus (Settings while the switch is off).
 */
export function BasicsGrid({
  answers,
  blank,
  words = {},
  onPick,
  readOnly = false,
}: {
  answers: ProfileAnswers;
  blank: "unsure" | "notPicked";
  words?: Partial<Record<ProfileKey, string>>;
  onPick: (key: ProfileKey, value: string) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="mt-2.5 rounded-xl border border-shell-line bg-shell-card">
      {QUESTIONS.map((q) => {
        const value = answers[q.key];
        const asks = !answerLabel(q.key, value) && blank === "unsure" && !readOnly;
        const unclear = words[q.key]?.trim();
        return (
          <div
            key={q.key}
            className={`flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-shell-line px-4 py-2.5 first:rounded-t-xl first:border-t-0 last:rounded-b-xl ${
              asks ? "bg-amber-50 dark:bg-amber-950/30" : ""
            }`}
          >
            <p className="w-full text-sm text-shell-muted sm:w-[180px] sm:shrink-0">{q.short}</p>
            {asks ? (
              <>
                <span className="inline-flex rounded-full border border-dashed border-amber-700 px-3 py-[5px] text-sm text-amber-700 dark:border-amber-300 dark:text-amber-300">
                  {BASICS_WORDS.notSure}
                </span>
                <div className="w-full sm:pl-[196px]">
                  {unclear ? <p className="text-[13px] leading-[18px] text-amber-700 dark:text-amber-300">{BASICS_WORDS.whyUnsure(unclear)}</p> : null}
                  <div role="group" aria-label={q.short} className={`flex flex-wrap gap-2 ${unclear ? "mt-2.5" : ""}`}>
                    {q.options.map((o) => (
                      <button
                        key={o.key}
                        type="button"
                        onClick={() => onPick(q.key, o.key)}
                        className="rounded-full border border-shell-line bg-shell-card px-3 py-1 text-[13px] leading-[18px] text-shell-ink hover:border-shell-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-shell-accent"
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : readOnly ? (
              <AnswerChip q={q} value={value} />
            ) : (
              <AnswerMenu q={q} value={value} onPick={onPick} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---- What Vizzy heard ------------------------------------------------------------------------

/** Each kind's picture and colours, as the mockups draw them (one quiet hue per kind, light and dark). */
export const KIND_LOOK: Record<FactKind, { icon: ComponentType<LucideProps>; tile: string; text: string }> = {
  timeline: { icon: Calendar, tile: "bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300", text: "text-blue-700 dark:text-blue-300" },
  channel: { icon: Signpost, tile: "bg-violet-50 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300", text: "text-violet-700 dark:text-violet-300" },
  start: { icon: Flag, tile: "bg-amber-50 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300", text: "text-amber-700 dark:text-amber-300" },
  constraint: { icon: Clock, tile: "bg-rose-50 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300", text: "text-rose-700 dark:text-rose-300" },
  goal: { icon: Target, tile: "bg-green-50 text-green-700 dark:bg-green-900/40 dark:text-green-300", text: "text-green-700 dark:text-green-300" },
};

export interface FactRow {
  id: string;
  kind: FactKind;
  text: string;
  quote: string;
  /** Where it came from ("From our call, 25 Nov"), in Settings. */
  src?: string;
}

/**
 * The facts, each with its kind, the member's own words and Remove. `compact` is Settings' look:
 * the words and where they came from on one line.
 */
export function FactList({ facts, onRemove, compact = false, busyId = null }: { facts: readonly FactRow[]; onRemove: (id: string) => void; compact?: boolean; busyId?: string | null }) {
  return (
    <ul className={`${compact ? "" : "mt-2.5 "}overflow-hidden rounded-xl border border-shell-line bg-shell-card`}>
      {facts.map((f) => {
        const look = KIND_LOOK[f.kind];
        const Icon = look.icon;
        return (
          <li key={f.id} className={`flex items-start gap-3.5 border-t border-shell-line px-4 first:border-t-0 ${compact ? "py-2.5" : "py-3.5"}`}>
            <span aria-hidden className={`grid shrink-0 place-items-center rounded-lg ${compact ? "h-7 w-7" : "h-8 w-8"} ${look.tile}`}>
              <Icon size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <span className="text-sm font-semibold text-shell-ink">{f.text}</span>
                <span className={`text-[11px] font-semibold uppercase leading-4 tracking-[0.05em] ${look.text}`}>{FACT_KIND_LABEL[f.kind]}</span>
              </p>
              {compact ? (
                <p className="mt-0.5 text-sm">
                  <q className="italic text-shell-muted">{f.quote}</q>
                  {f.src ? (
                    <span className="whitespace-nowrap text-xs text-shell-faint">
                      <span aria-hidden className="mx-1.5">
                        ·
                      </span>
                      {f.src}
                    </span>
                  ) : null}
                </p>
              ) : (
                <>
                  <q className="mt-1.5 block border-l-2 border-shell-line pl-2.5 text-sm italic text-shell-muted">{f.quote}</q>
                  {f.src ? <span className="mt-1 block text-xs text-shell-faint">{f.src}</span> : null}
                </>
              )}
            </div>
            <button
              type="button"
              aria-label={FACT_WORDS.removeAria(f.text)}
              onClick={() => onRemove(f.id)}
              disabled={busyId === f.id}
              aria-busy={busyId === f.id || undefined}
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-shell-muted hover:bg-shell-hover hover:text-shell-ink disabled:opacity-60"
            >
              <X size={14} aria-hidden />
              {FACT_WORDS.remove}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ---- The conversation dialogs ----------------------------------------------------------------

export const BUTTON =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-shell-line bg-shell-card px-3 py-1.5 text-sm font-medium text-shell-ink hover:bg-shell-hover disabled:opacity-60";
export const BUTTON_DANGER =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-shell-line bg-shell-card px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40 disabled:opacity-60";
const BUTTON_DANGER_SOLID =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-red-600 bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:border-red-700 hover:bg-red-700 dark:hover:border-red-500 dark:hover:bg-red-500 disabled:opacity-60";
const BOX =
  "fixed left-1/2 top-[88px] z-50 flex max-h-[calc(100vh-120px)] w-[min(512px,calc(100%-32px))] -translate-x-1/2 flex-col rounded-lg border border-shell-line bg-shell-card p-5 text-shell-ink shadow-xl outline-none";

/** A kept conversation, as a dialog names it. */
export interface ConversationMeta {
  id: string;
  source: ConversationSource;
  startedAt: string;
  lengthSec: number;
}

export interface TranscriptTurn {
  who: "member" | "vizzy";
  text: string;
}

/** The words of one conversation, as they load. */
export type Loaded = { id: string; status: "loading" } | { id: string; status: "failed" } | { id: string; status: "ok"; turns: TranscriptTurn[] };

/** "Call with Vizzy" and "25 Nov, 4 min 12 s, 9 turns" (or a chat's messages). */
export function conversationName(c: ConversationMeta, turns: number | null): { name: string; meta: string } {
  const date = shortDate(c.startedAt);
  if (c.source === "chat") return { name: TRANSCRIPT_WORDS.chat, meta: TRANSCRIPT_WORDS.chatMeta(date, messageCount(turns ?? 0)) };
  const length = longLength(c.lengthSec);
  return { name: TRANSCRIPT_WORDS.call, meta: turns === null ? `${date}, ${length}` : TRANSCRIPT_WORDS.callMeta(date, length, turns) };
}

/** The dialog's body: who said what, as loaded. Apart, so a test can read it without a browser. */
export function TranscriptBody({ c, loaded, onRetry }: { c: ConversationMeta; loaded: Loaded | null; onRetry: () => void }) {
  const turns = loaded?.status === "ok" ? loaded.turns : null;
  const { name, meta } = conversationName(c, turns ? turns.length : null);
  return (
    <>
      <div>
        <p className="font-medium">{name}</p>
        <p className="text-xs text-shell-faint">{meta}</p>
      </div>
      {turns ? (
        <ol className="flex max-h-[420px] min-h-0 flex-col gap-3 overflow-y-auto">
          {turns.map((t, i) => (
            <li key={i} className={t.who === "vizzy" ? "pr-6" : "pl-6"}>
              <span className="block text-xs text-shell-faint">{t.who === "vizzy" ? TRANSCRIPT_WORDS.vizzy : TRANSCRIPT_WORDS.you}</span>
              <span className="block whitespace-pre-wrap break-words">{t.text}</span>
            </li>
          ))}
        </ol>
      ) : loaded?.status === "failed" ? (
        <p role="alert" className="text-shell-ink">
          {TRANSCRIPT_WORDS.failed}{" "}
          <button type="button" onClick={onRetry} className="font-medium text-shell-accent hover:underline">
            {TRANSCRIPT_WORDS.retry}
          </button>
        </p>
      ) : (
        <p role="status" aria-busy="true" className="text-shell-muted">
          {TRANSCRIPT_WORDS.loading}
        </p>
      )}
      <p className="text-xs text-shell-faint">{TRANSCRIPT_WORDS.private}</p>
    </>
  );
}

/**
 * Read the conversation: its words load when it opens (they are never in the page). `onDelete`
 * adds Delete, as Settings has it; Learned leaves it out, since its words wait for Looks right.
 */
export function TranscriptDialog({ open, onClose, conversation, onDelete }: { open: boolean; onClose: () => void; conversation: ConversationMeta | null; onDelete?: () => void }) {
  const container = useThemePortalContainer();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const id = conversation?.id ?? null;

  const load = useCallback(async (convId: string) => {
    setLoaded({ id: convId, status: "loading" });
    let next: Loaded = { id: convId, status: "failed" };
    try {
      const res = await fetch(`/api/admin/onboarding/conversations/${encodeURIComponent(convId)}`, { cache: "no-store" });
      const body = res.ok ? ((await res.json()) as { conversation?: { turns?: TranscriptTurn[] } }) : null;
      const turns = body?.conversation?.turns;
      if (Array.isArray(turns)) next = { id: convId, status: "ok", turns: turns.map((t) => ({ who: t.who === "vizzy" ? "vizzy" : "member", text: String(t.text) })) };
    } catch {
      // Shown as failed, with Try again.
    }
    // A reply for a conversation no longer open is dropped.
    setLoaded((cur) => (cur?.id === convId ? next : cur));
  }, []);

  useEffect(() => {
    if (open && id && loaded?.id !== id) void load(id);
  }, [open, id, loaded?.id, load]);

  return (
    <Dialog.Root open={open && !!conversation} onOpenChange={(o) => (o ? null : onClose())}>
      <Dialog.Portal container={container}>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content aria-describedby={undefined} className={BOX}>
          <div className="mb-3 flex items-start justify-between gap-3">
            <Dialog.Title className="text-sm font-semibold">{TRANSCRIPT_WORDS.title}</Dialog.Title>
            <Dialog.Close aria-label={TRANSCRIPT_WORDS.close} className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-shell-faint hover:bg-shell-hover">
              <X size={16} aria-hidden />
            </Dialog.Close>
          </div>
          <div className="flex min-h-0 flex-col gap-4 text-sm">
            {conversation ? <TranscriptBody c={conversation} loaded={loaded?.id === conversation.id ? loaded : null} onRetry={() => void load(conversation.id)} /> : null}
            <div className="flex flex-wrap items-center justify-end gap-2">
              {onDelete ? (
                <button type="button" onClick={onDelete} className={`mr-auto ${BUTTON_DANGER}`}>
                  {TRANSCRIPT_WORDS.delete}
                </button>
              ) : null}
              <Dialog.Close className={BUTTON}>{TRANSCRIPT_WORDS.close}</Dialog.Close>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** "The transcript of your call on 25 Nov goes for good." */
export function deleteConversationText(c: Pick<ConversationMeta, "source" | "startedAt">): string {
  return DELETE_CONVERSATION_WORDS.text(c.source === "chat" ? "chat" : "call", shortDate(c.startedAt));
}

/**
 * Delete this conversation? The caller deletes in `onConfirm` and closes it when that works;
 * `error` shows when it didn't.
 */
export function DeleteConversationDialog({
  open,
  onClose,
  conversation,
  onConfirm,
  busy = false,
  error = null,
}: {
  open: boolean;
  onClose: () => void;
  conversation: Pick<ConversationMeta, "source" | "startedAt"> | null;
  onConfirm: () => void;
  busy?: boolean;
  error?: string | null;
}) {
  const container = useThemePortalContainer();
  return (
    <Dialog.Root open={open && !!conversation} onOpenChange={(o) => (o ? null : onClose())}>
      <Dialog.Portal container={container}>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content role="alertdialog" className={BOX}>
          <div className="mb-3 flex items-start justify-between gap-3">
            <Dialog.Title className="text-sm font-semibold">{DELETE_CONVERSATION_WORDS.title}</Dialog.Title>
            <Dialog.Close aria-label={DELETE_CONVERSATION_WORDS.close} className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-shell-faint hover:bg-shell-hover">
              <X size={16} aria-hidden />
            </Dialog.Close>
          </div>
          <div className="flex flex-col gap-4 text-sm">
            <Dialog.Description>{conversation ? deleteConversationText(conversation) : ""}</Dialog.Description>
            <p className="text-xs text-shell-faint">{DELETE_CONVERSATION_WORDS.keep}</p>
            {error ? (
              <p role="alert" className="text-shell-ink">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Dialog.Close className={BUTTON}>{DELETE_CONVERSATION_WORDS.cancel}</Dialog.Close>
              <button type="button" onClick={onConfirm} disabled={busy} aria-busy={busy || undefined} className={BUTTON_DANGER_SOLID}>
                <Trash2 size={14} aria-hidden />
                {DELETE_CONVERSATION_WORDS.confirm}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
