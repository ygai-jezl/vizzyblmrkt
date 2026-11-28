"use client";

import { useState } from "react";
import { Modal } from "@/components/admin/email/Modal";
import type { DeckView } from "@/lib/raise/docs/adminApi";
import type { DeckTheme } from "@/lib/raise/docs/theme";
import { dayWords } from "@/lib/raise/docs/text";
import type { DeckAudience, DeckStage } from "@/lib/raise/docs/types";
import { RAISE_MESSAGES, STUDIO_WORDS } from "@/lib/raise/docs/words";
import { messageFor, readVersion, restoreVersion, type KeptVersion } from "./api";
import { SlideFrame } from "./SlideFrame";
import { SlideView } from "./SlideView";

const BY: Record<DeckView["versions"][number]["by"], string> = { Vizzy: STUDIO_WORDS.byVizzy, You: STUDIO_WORDS.byYou, "A teammate": STUDIO_WORDS.byTeammate };

/** "by Vizzy", "by you" or "by a teammate". */
export const byWords = (by: DeckView["versions"][number]["by"]) => BY[by] ?? STUDIO_WORDS.byTeammate;

export interface VersionsDrawerProps {
  open: boolean;
  onClose: () => void;
  deckId: string;
  versions: DeckView["versions"];
  /** The newest version, which a put back is made from. */
  version: number;
  canEdit: boolean;
  theme: DeckTheme;
  audience: DeckAudience;
  stage: DeckStage;
  now: Date;
  /** Changes here aren't saved: putting a version back would lose them. */
  dirty: boolean;
  onRestored: (doc: DeckView) => void;
}

/**
 * Versions: every change with its note, who made it and when. Kept versions can be viewed and, by
 * admins, put back as a new version; a version no longer kept keeps its note in the list.
 */
export function VersionsDrawer({ open, onClose, deckId, versions, version, canEdit, theme, audience, stage, now, dirty, onRestored }: VersionsDrawerProps) {
  const [viewing, setViewing] = useState<KeptVersion | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function view(n: number) {
    setError(null);
    setBusy(n);
    const r = await readVersion(deckId, n);
    setBusy(null);
    if (r.ok && r.data.version) setViewing(r.data.version);
    else setError(messageFor(r.data.error));
  }

  async function putBack(n: number) {
    setError(null);
    setBusy(n);
    const r = await restoreVersion(deckId, n, version);
    setBusy(null);
    if (r.ok && r.data.doc) {
      setViewing(null);
      onRestored(r.data.doc);
    } else setError(messageFor(r.data.error));
  }

  const putBackButton = (n: number) =>
    canEdit && n !== version ? (
      <button type="button" disabled={busy !== null || dirty} title={dirty ? STUDIO_WORDS.saveFirst : undefined} onClick={() => void putBack(n)} className="text-xs text-blue-700 hover:underline disabled:opacity-50 dark:text-blue-300">
        {STUDIO_WORDS.putBack}
      </button>
    ) : null;

  return (
    <>
      <Modal open={open && !viewing} onClose={onClose} title={STUDIO_WORDS.versionsTitle}>
        <ul className="max-h-[60vh] space-y-3 overflow-y-auto">
          {versions.map((v) => (
            <li key={v.n} className="space-y-1 border-b border-neutral-200 pb-3 text-sm last:border-0 dark:border-neutral-800">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <strong>{STUDIO_WORDS.versionN(v.n)}</strong>
                <span className="text-xs text-neutral-500">
                  {byWords(v.by)}, {dayWords(v.at, now)}
                </span>
              </div>
              <p>{v.note}</p>
              {v.kept ? (
                <div className="flex gap-3">
                  <button type="button" disabled={busy !== null} onClick={() => void view(v.n)} className="text-xs text-blue-700 hover:underline disabled:opacity-50 dark:text-blue-300">
                    {STUDIO_WORDS.view}
                  </button>
                  {putBackButton(v.n)}
                </div>
              ) : (
                <p className="text-xs text-neutral-500">{RAISE_MESSAGES.versionNotKept}</p>
              )}
            </li>
          ))}
        </ul>
        {error ? (
          <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        ) : null}
        <p className="mt-3 text-xs text-neutral-500">{STUDIO_WORDS.versionsFoot}</p>
      </Modal>
      <Modal open={open && viewing !== null} onClose={() => setViewing(null)} title={viewing ? STUDIO_WORDS.versionN(viewing.n) : ""} wide>
        {viewing ? (
          <div className="space-y-3">
            <p className="text-sm">{viewing.note}</p>
            <div className="grid max-h-[60vh] grid-cols-2 gap-3 overflow-y-auto md:grid-cols-3">
              {viewing.slides.map((s, i) => (
                <div key={s.id} className="space-y-1">
                  <span className="text-xs text-neutral-500">{STUDIO_WORDS.slideN(i + 1)}</span>
                  <SlideFrame scale={0.2} className="rounded-sm border border-neutral-200 dark:border-neutral-800">
                    <SlideView slide={s} theme={theme} n={i + 1} total={viewing.slides.length} title={viewing.title} audience={audience} stage={stage} mode="thumb" version={{ n: viewing.n, at: viewing.at }} now={now} />
                  </SlideFrame>
                </div>
              ))}
            </div>
            {error ? (
              <p role="alert" className="text-sm text-red-700 dark:text-red-400">
                {error}
              </p>
            ) : null}
            <div className="flex gap-3">{putBackButton(viewing.n)}</div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
