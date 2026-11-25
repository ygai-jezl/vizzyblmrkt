"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { FORMER_TEAM_MEMBER } from "@/lib/team/former";
import { IDEA_LIMITS, type Idea, type IdeaStatus } from "@/lib/types/campaign";
import { IDEA_MESSAGES, IDEA_STATUS_LABEL, IDEA_STATUS_OPTIONS, IDEA_STATUS_TONE, ideaErrorText, JUST_A_LIST } from "@/lib/ideas/words";
import { api } from "../connect/api";
import { Banner, Button, inputClass } from "../connect/ui";
import { Chip, chipToneClass } from "../people/Chip";

/**
 * A launch's idea on its Overview (LAUNCH_IDEAS_ENABLED): the status (saved on click, with who set
 * it and when), the hypothesis and outcome (saved with Save), and Just a list. Parked or killed
 * offers to close the waitlist; nothing closes on its own. Admins change it; everyone else reads it.
 * A launch marked Just a list shows one line instead, with Make it an idea for an admin.
 */

const CLOSING: readonly IdeaStatus[] = ["parked", "killed"];

export interface IdeaCardProps {
  campaignId: string;
  idea: Idea;
  canEdit: boolean;
  /** The waitlist is closed already: nothing to offer. */
  archived: boolean;
  /** The viewer's user id, so their own changes say "you". */
  viewerId: string | null;
  /** Team members' names by user id, for who set the status. */
  names: Readonly<Record<string, string>>;
}

interface IdeaReply {
  ok?: boolean;
  idea?: Idea;
  archived?: boolean | null;
  error?: string;
}

const count = (n: number) => n.toLocaleString("en-GB");

/** "18 Nov", with the year when it isn't this one. */
export function ideaDay(iso: string | null | undefined, now: Date = new Date()): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  const sameYear = d.getUTCFullYear() === now.getUTCFullYear();
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" }).format(d);
}

/** Who did something: "you", a team member's name, or Former team member. */
export function whoDid(userId: string | null | undefined, viewerId: string | null, names: Readonly<Record<string, string>>): string | null {
  if (!userId) return null;
  if (userId === viewerId) return "you";
  return Object.hasOwn(names, userId) ? names[userId]! : FORMER_TEAM_MEMBER;
}

/** "Set to Testing by you on 18 Nov." */
export function statusLine(idea: Idea, viewerId: string | null, names: Readonly<Record<string, string>>): string {
  if (!idea.status) return "No status yet.";
  const who = whoDid(idea.statusBy, viewerId, names);
  const when = ideaDay(idea.statusAt);
  return `Set to ${IDEA_STATUS_LABEL[idea.status]}${who ? ` by ${who}` : ""}${when ? ` on ${when}` : ""}.`;
}

export function IdeaCard({ campaignId, idea: initial, canEdit, archived, viewerId, names }: IdeaCardProps) {
  const router = useRouter();
  const [idea, setIdea] = useState<Idea>(initial);
  const [hyp, setHyp] = useState(initial.hypothesis ?? "");
  const [out, setOut] = useState(initial.outcome ?? "");
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [offer, setOffer] = useState(false);
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function patch(body: Record<string, unknown>): Promise<IdeaReply | null> {
    setBusy(true);
    setError(null);
    const r = await api<IdeaReply>(`/api/admin/campaigns/${encodeURIComponent(campaignId)}/idea`, { method: "PATCH", body: JSON.stringify(body) });
    setBusy(false);
    if (!r.ok || !r.data.idea) {
      setError(ideaErrorText(r.data.error));
      return null;
    }
    setIdea(r.data.idea);
    return r.data;
  }

  async function pickStatus(status: IdeaStatus) {
    if (status === idea.status || busy) return;
    if (!(await patch({ status }))) return;
    setOffer(CLOSING.includes(status) && !archived && !closed);
    router.refresh();
  }

  async function closeWaitlist() {
    const r = await patch({ closeWaitlist: true });
    if (!r) return;
    if (r.archived) {
      setOffer(false);
      setClosed(true);
      router.refresh();
    } else {
      setError(IDEA_MESSAGES.closeFailed);
    }
  }

  async function saveText() {
    const r = await patch({ hypothesis: hyp, outcome: out });
    if (!r?.idea) return;
    setHyp(r.idea.hypothesis ?? "");
    setOut(r.idea.outcome ?? "");
    setDirty(false);
    setSaved(true);
  }

  async function setList(justAList: boolean) {
    if (await patch({ justAList })) router.refresh();
  }

  if (idea.justAList) {
    return (
      <div role="note" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-neutral-300 px-4 py-3 text-sm dark:border-neutral-700">
        <p className="text-neutral-600 dark:text-neutral-400">{JUST_A_LIST}: no hypothesis or status, and it&apos;s left out of comparisons.</p>
        {canEdit ? (
          <Button onClick={() => void setList(false)} disabled={busy}>
            Make it an idea
          </Button>
        ) : null}
        {error ? <Banner tone="err">{error}</Banner> : null}
      </div>
    );
  }

  const status = idea.status;
  return (
    <section aria-labelledby="idea-card-h" className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="idea-card-h" className="text-sm font-semibold">
          Idea
        </h2>
        <p className="text-xs text-neutral-500">Admins change it. Everyone on the team can read it.</p>
      </div>

      <div className="space-y-1.5">
        <p id="idea-status-l" className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
          Status
        </p>
        {canEdit ? (
          <div role="radiogroup" aria-labelledby="idea-status-l" className="flex flex-wrap gap-1.5">
            {IDEA_STATUS_OPTIONS.map((o) => {
              const on = o.value === status;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={busy}
                  onClick={() => void pickStatus(o.value)}
                  className={`rounded-full border px-2.5 py-0.5 text-xs font-medium disabled:cursor-wait ${
                    on ? `border-current ${chipToneClass(o.tone)}` : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                  }`}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        ) : status ? (
          <Chip tone={IDEA_STATUS_TONE[status]}>{IDEA_STATUS_LABEL[status]}</Chip>
        ) : null}
        <p className="text-xs text-neutral-500">{statusLine(idea, viewerId, names)}</p>
      </div>

      {offer && status && CLOSING.includes(status) ? (
        <div role="status" className="space-y-2 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-900">
          <p>{IDEA_STATUS_LABEL[status]}. The waitlist is still open: people can still join, and its emails still go out.</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setOffer(false)} disabled={busy}>
              Keep it open
            </Button>
            <Button tone="primary" onClick={() => void closeWaitlist()} disabled={busy}>
              Also close the waitlist
            </Button>
          </div>
        </div>
      ) : null}
      {closed ? <Banner tone="info">Waitlist closed. Nobody new can join and its emails are paused. It&apos;s under Archived on the list now.</Banner> : null}

      <TextPart
        label="Hypothesis"
        hint="What you expect to happen, and for whom."
        placeholder="Plant owners will pay each month for a box of care supplies."
        value={hyp}
        limit={IDEA_LIMITS.hypothesis}
        canEdit={canEdit}
        onChange={(v) => {
          setHyp(v);
          setDirty(true);
          setSaved(false);
        }}
      />
      <TextPart
        label="Outcome"
        hint="Fill this in as you learn. It stays with the idea."
        placeholder="What happened, and what you learned."
        value={out}
        limit={IDEA_LIMITS.outcome}
        canEdit={canEdit}
        onChange={(v) => {
          setOut(v);
          setDirty(true);
          setSaved(false);
        }}
      />
      {canEdit ? (
        <div className="flex items-center gap-3">
          <Button tone="primary" onClick={() => void saveText()} disabled={!dirty || busy}>
            Save
          </Button>
          {saved ? <span className="text-xs text-neutral-500">Saved by you just now.</span> : null}
        </div>
      ) : null}

      {canEdit ? (
        <label className="flex items-start gap-2 border-t border-neutral-100 pt-3 text-sm dark:border-neutral-900">
          <input type="checkbox" className="mt-0.5" checked={false} disabled={busy} onChange={() => void setList(true)} />
          <span>
            <span className="block text-xs font-medium text-neutral-600 dark:text-neutral-400">{JUST_A_LIST}</span>
            <span className="block text-xs text-neutral-500">
              For a newsletter or sign up list that isn&apos;t an idea. It hides this card and leaves the list out of comparisons.
            </span>
          </span>
        </label>
      ) : null}

      {error ? <Banner tone="err">{error}</Banner> : null}
    </section>
  );
}

function TextPart({
  label,
  hint,
  placeholder,
  value,
  limit,
  canEdit,
  onChange,
}: {
  label: string;
  hint: string;
  placeholder?: string;
  value: string;
  limit: number;
  canEdit: boolean;
  onChange: (value: string) => void;
}): ReactNode {
  if (!canEdit) {
    return (
      <div className="space-y-1">
        <p className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</p>
        <p className={`whitespace-pre-wrap text-sm ${value ? "" : "text-neutral-500"}`}>{value || "None yet."}</p>
      </div>
    );
  }
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      <textarea rows={3} maxLength={limit} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={inputClass} />
      <span className="flex justify-between gap-3 text-xs text-neutral-500">
        <span>{hint}</span>
        <span className="shrink-0 tabular-nums">
          {count(value.length)} of {count(limit)}
        </span>
      </span>
    </label>
  );
}
