"use client";

import { useEffect, useRef, useState } from "react";
import { MessageCircle, Mic } from "lucide-react";
import {
  conversationRow,
  decisionProblem,
  factSource,
  isGone,
  talkLabel,
  undoPick,
  waitingSource,
  withConversation,
  type AboutConversation,
  type AboutFact,
  type AboutWaiting,
} from "@/lib/onboarding/aboutYourBusiness";
import { ABOUT_WORDS, DELETE_CONVERSATION_WORDS } from "@/lib/onboarding/words";
import type { ProfileAnswers, ProfileKey } from "@/lib/types/businessProfile";
import { BUTTON, BUTTON_DANGER, BasicsGrid, DeleteConversationDialog, FactList, TranscriptDialog } from "./parts";

export interface AboutYourBusinessProps {
  answers: ProfileAnswers;
  /** Null when the list didn't load. */
  facts: AboutFact[] | null;
  conversations: AboutConversation[] | null;
  /**
   * What Vizzy heard in later chats, waiting for an admin to keep (ONBOARDING_ENABLED). Empty with
   * the switch off; null when the list didn't load.
   */
  waiting?: AboutWaiting[] | null;
  /** Talk with Vizzy is on for this brand (the welcome's voice rule, with nav v2 phase 2). */
  voice: boolean;
  /** The chips save (ONBOARDING_ENABLED). Off, they show what was picked, and kept words can still be read and deleted. */
  editable: boolean;
}

const H3 = "flex items-baseline gap-2 text-sm font-semibold";
const EMPTY = "text-sm text-shell-muted";
const ERROR = "text-sm text-shell-ink";
/** Where the welcome is: a whole page load, so its microphone header applies (next.config.ts). */
const WELCOME_HREF = "/admin/welcome";

type Dialog = { kind: "transcript" | "delete"; id: string } | null;

/**
 * Settings, General, About your business (admins): the four answers as chips that save at once,
 * what Vizzy learned with Remove, the kept conversations with their transcript and Delete, and
 * Talk with Vizzy (again) when voice is on. The page reads the brand's answers and both lists on
 * the server; every change here goes to its own route.
 */
export function AboutYourBusiness({
  answers: initialAnswers,
  facts: initialFacts,
  conversations: initialConversations,
  waiting: initialWaiting = [],
  voice,
  editable,
}: AboutYourBusinessProps) {
  const [answers, setAnswers] = useState<ProfileAnswers>(initialAnswers);
  const [facts, setFacts] = useState<AboutFact[] | null>(initialFacts);
  const [waiting, setWaiting] = useState<AboutWaiting[]>(initialWaiting ?? []);
  const [conversations, setConversations] = useState<AboutConversation[] | null>(initialConversations);
  const [error, setError] = useState<{ where: "basics" | "facts"; text: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(0);
  const factsHeading = useRef<HTMLHeadingElement>(null);
  const conversationsHeading = useRef<HTMLHeadingElement>(null);

  // After a delete the row and its buttons are gone: focus lands on the section, not the page.
  useEffect(() => {
    if (!deleted) return;
    const frame = requestAnimationFrame(() => conversationsHeading.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [deleted]);

  const pick = async (key: ProfileKey, value: string) => {
    if (!editable || answers[key] === value) return;
    const before = answers[key];
    setAnswers((a) => ({ ...a, [key]: value }));
    setError(null);
    const res = await fetch("/api/admin/onboarding/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: { [key]: value }, via: "settings" }),
    }).catch(() => null);
    if (res?.ok) return;
    setAnswers((a) => undoPick(a, key, value, before));
    setError({ where: "basics", text: ABOUT_WORDS.notSaved });
  };

  /** Keep or remove something Vizzy heard in a chat: it leaves the waiting rows either way it is decided. */
  const decide = async (id: string, decision: "keep" | "remove") => {
    if (removing) return;
    setRemoving(id);
    setError(null);
    const res = await fetch(`/api/admin/onboarding/suggestions/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    }).catch(() => null);
    const body = res ? ((await res.json().catch(() => ({}))) as { error?: string; fact?: AboutFact; conversation?: AboutConversation }) : null;
    setRemoving(null);
    const problem = decisionProblem(res ? { ok: res.ok, status: res.status, error: body?.error } : null, decision);
    if (!problem || problem.drop) setWaiting((list) => list.filter((w) => w.id !== id));
    if (!problem && decision === "keep" && body?.fact) {
      const fact = body.fact;
      setFacts((list) => (list ? [...list.filter((f) => f.id !== fact.id), fact] : list));
      const kept = body.conversation;
      if (kept) setConversations((list) => (list ? withConversation(list, kept) : list));
    }
    if (problem) setError({ where: "facts", text: problem.text });
    factsHeading.current?.focus();
  };

  const remove = async (id: string) => {
    if (waiting.some((w) => w.id === id)) return decide(id, "remove");
    if (removing) return;
    setRemoving(id);
    setError(null);
    const res = await fetch(`/api/admin/onboarding/facts/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    setRemoving(null);
    if (isGone(res)) {
      setFacts((list) => (list ? list.filter((f) => f.id !== id) : list));
      factsHeading.current?.focus();
      return;
    }
    setError({ where: "facts", text: ABOUT_WORDS.notRemoved });
  };

  const open = dialog ? (conversations ?? []).find((c) => c.id === dialog.id) ?? null : null;
  const closeDialog = () => {
    setDialog(null);
    setDeleteError(null);
  };

  const confirmDelete = async () => {
    if (!open || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    const res = await fetch(`/api/admin/onboarding/conversations/${encodeURIComponent(open.id)}`, { method: "DELETE" }).catch(() => null);
    setDeleting(false);
    if (!isGone(res)) {
      setDeleteError(DELETE_CONVERSATION_WORDS.failed);
      return;
    }
    setConversations((list) => (list ? list.filter((c) => c.id !== open.id) : list));
    setDialog(null);
    setDeleted((n) => n + 1);
  };

  const shownFacts = facts
    ? [...(editable ? waiting.map((w) => ({ ...w, src: waitingSource(w), waiting: true })) : []), ...facts.map((f) => ({ ...f, src: factSource(f) }))]
    : null;

  return (
    // `#about`: where Review and Vizzy's chat card link (src/lib/onboarding/factSuggestions.ts).
    <section id="about" aria-labelledby="about-business" className="flex max-w-[760px] scroll-mt-6 flex-col gap-5 text-shell-ink">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div>
          <h2 id="about-business" className="text-base font-semibold">
            {ABOUT_WORDS.title}
          </h2>
          <p className="mt-0.5 text-sm text-shell-muted">{ABOUT_WORDS.lead}</p>
        </div>
        {voice ? (
          // A plain link, never a client navigation: the microphone is allowed on the welcome's own page load only.
          <a
            href={WELCOME_HREF}
            className="inline-flex items-center gap-2 rounded-full border border-shell-line py-1.5 pl-2 pr-3 text-sm font-medium text-shell-ink hover:bg-shell-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-shell-accent"
          >
            <span aria-hidden className="grid h-6 w-6 place-items-center rounded-full bg-shell-accent text-white">
              <Mic size={14} />
            </span>
            {talkLabel(conversations ?? [])}
          </a>
        ) : null}
      </div>

      {deleted ? (
        <p role="status" className="rounded-md border border-[color:var(--ob-ok-line)] bg-[color:var(--ob-ok-bg)] px-3 py-2 text-sm text-[color:var(--ob-ok-text)]">
          {ABOUT_WORDS.deleted}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <h3 className={H3}>{ABOUT_WORDS.basics}</h3>
        <BasicsGrid answers={answers} blank="notPicked" readOnly={!editable} onPick={(key, value) => void pick(key, value)} />
        {error?.where === "basics" ? (
          <p role="alert" className={ERROR}>
            {error.text}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <h3 ref={factsHeading} tabIndex={-1} className={`${H3} outline-none`}>
          {ABOUT_WORDS.learned}{" "}
          {shownFacts ? <span className="text-xs font-medium text-shell-faint">{shownFacts.length}</span> : null}
        </h3>
        {shownFacts === null ? (
          <p className={EMPTY}>{ABOUT_WORDS.notLoaded}</p>
        ) : shownFacts.length ? (
          <FactList facts={shownFacts} compact busyId={removing} onRemove={(id) => void remove(id)} onKeep={(id) => void decide(id, "keep")} />
        ) : (
          <p className={EMPTY}>{ABOUT_WORDS.noFacts}</p>
        )}
        {error?.where === "facts" ? (
          <p role="alert" className={ERROR}>
            {error.text}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <h3 ref={conversationsHeading} tabIndex={-1} className={`${H3} outline-none`}>
          {ABOUT_WORDS.conversations}
        </h3>
        {conversations === null ? (
          <p className={EMPTY}>{ABOUT_WORDS.notLoaded}</p>
        ) : conversations.length ? (
          <div className="overflow-x-auto rounded-xl border border-shell-line bg-shell-card">
            <table aria-label={ABOUT_WORDS.table} className="w-full min-w-[520px] text-sm">
              <thead className="text-left text-xs text-shell-muted">
                <tr className="border-b border-shell-line">
                  <th scope="col" className="px-4 py-2 font-medium">
                    {ABOUT_WORDS.conversation}
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    {ABOUT_WORDS.date}
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    {ABOUT_WORDS.length}
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    <span className="sr-only">{ABOUT_WORDS.actions}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-shell-line">
                {conversations.map((c) => {
                  const row = conversationRow(c);
                  const Icon = row.what === "chat" ? MessageCircle : Mic;
                  return (
                    <tr key={c.id}>
                      <td className="px-4 py-2.5">
                        <span className="flex items-center gap-2">
                          <span aria-hidden className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-shell-active text-shell-muted">
                            <Icon size={14} />
                          </span>
                          <span className="font-medium">{row.name}</span>
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">{row.date}</td>
                      <td className="whitespace-nowrap px-4 py-2.5">{row.length}</td>
                      <td className="px-4 py-2.5">
                        <span className="flex justify-end gap-1.5">
                          <button
                            type="button"
                            aria-label={row.viewAria}
                            aria-haspopup="dialog"
                            onClick={() => setDialog({ kind: "transcript", id: c.id })}
                            className={`${BUTTON} px-2.5 py-1 text-xs`}
                          >
                            {ABOUT_WORDS.view}
                          </button>
                          <button
                            type="button"
                            aria-label={row.deleteAria}
                            aria-haspopup="dialog"
                            onClick={() => setDialog({ kind: "delete", id: c.id })}
                            className={`${BUTTON_DANGER} px-2.5 py-1 text-xs`}
                          >
                            {ABOUT_WORDS.delete}
                          </button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={EMPTY}>{ABOUT_WORDS.noConversations}</p>
        )}
        <p className="text-xs text-shell-faint">{ABOUT_WORDS.kept}</p>
      </div>

      <TranscriptDialog
        open={dialog?.kind === "transcript"}
        onClose={closeDialog}
        conversation={dialog?.kind === "transcript" ? open : null}
        onDelete={() => open && setDialog({ kind: "delete", id: open.id })}
      />
      <DeleteConversationDialog
        open={dialog?.kind === "delete"}
        onClose={closeDialog}
        conversation={dialog?.kind === "delete" ? open : null}
        onConfirm={() => void confirmDelete()}
        busy={deleting}
        error={deleteError}
      />
    </section>
  );
}
