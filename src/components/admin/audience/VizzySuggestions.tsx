"use client";

import { useCallback, useEffect, useState } from "react";
import type { SuggestionLine, SuggestionView } from "@/lib/audience/fieldSuggestions";
import { SUGGESTION_NOTES, suggestionErrorText } from "@/lib/audience/suggestionWords";
import { api } from "../connect/api";
import { Banner, Button } from "../connect/ui";
import { useShell } from "../nav/ShellProvider";
import { day } from "../people/format";

/**
 * "Vizzy suggests" on a person's page (AUDIENCE_VIZZY_FIELDS_ENABLED): each change to their fields
 * Vizzy suggested, from what to what and why, with Confirm and Dismiss for admins. What was
 * confirmed in the last 7 days can be undone. Nothing changes until someone confirms. Shown only
 * while there is something to show; it reloads when Vizzy saves a suggestion in this chat.
 */

type Data = { open: SuggestionView[]; confirmed: SuggestionView[] };

/** A day stored as YYYY-MM-DD, shown as a day whatever the viewer's time zone. */
const shown = (line: SuggestionLine, v: string | null) => (v === null ? "none" : line.type === "date" ? day(`${v}T12:00:00.000Z`, "UTC") : v);

function Lines({ lines }: { lines: SuggestionLine[] }) {
  return (
    <ul className="space-y-0.5 text-sm">
      {lines.map((l) => (
        <li key={l.fieldId}>
          <span className="font-medium">{l.label}:</span> {shown(l, l.before)} → {shown(l, l.after)}
        </li>
      ))}
    </ul>
  );
}

export function VizzySuggestions({ personId, canEdit, onChanged }: { personId: string; canEdit: boolean; onChanged: () => void }) {
  const shell = useShell();
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = `/api/admin/audience/everyone/${encodeURIComponent(personId)}/proposals`;

  const load = useCallback(async () => {
    const r = await api<Data>(path);
    if (r.ok) setData(r.data);
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  // Vizzy saved a suggestion in this chat: show it.
  const subscribe = shell?.onCanvasSaved ?? null;
  useEffect(() => {
    if (!subscribe) return;
    return subscribe((card) => {
      if (card.kind === "person_fields") void load();
    });
  }, [subscribe, load]);

  async function decide(s: SuggestionView, decision: "confirm" | "dismiss" | "undo") {
    setBusy(`${s.id}:${decision}`);
    setError(null);
    const r = await api<{ state: string }>(path, { method: "POST", body: JSON.stringify({ id: s.id, rev: s.rev, decision }) });
    setBusy(null);
    if (!r.ok) setError(suggestionErrorText(r.data));
    await load();
    // Their fields and timeline moved (a stale one was set aside too): the page reloads them.
    if (!r.ok || decision !== "dismiss") onChanged();
  }

  if (!data || (!data.open.length && !data.confirmed.length)) return error ? <Banner tone="err">{error}</Banner> : null;

  return (
    <section
      id="vizzy"
      aria-labelledby="vizzy-suggests"
      className="scroll-mt-16 space-y-3 rounded-lg border border-blue-300 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950/40"
    >
      <h3 id="vizzy-suggests" className="text-sm font-semibold text-blue-900 dark:text-blue-200">
        Vizzy suggests
      </h3>
      {data.open.map((s) => (
        <div key={s.id} className="space-y-2">
          <Lines lines={s.lines} />
          {s.why ? <p className="text-sm text-neutral-600 dark:text-neutral-300">{s.why}</p> : null}
          {canEdit ? (
            <div className="flex flex-wrap gap-2">
              <Button tone="primary" disabled={busy !== null} onClick={() => void decide(s, "confirm")}>
                {busy === `${s.id}:confirm` ? "Confirming…" : "Confirm"}
              </Button>
              <Button disabled={busy !== null} onClick={() => void decide(s, "dismiss")}>
                Dismiss
              </Button>
            </div>
          ) : null}
          <p className="text-xs text-neutral-500">
            {SUGGESTION_NOTES.waiting}
            {canEdit ? "" : ` ${SUGGESTION_NOTES.members}`}
          </p>
        </div>
      ))}
      {data.confirmed.map((s) => (
        <div key={s.id} className="space-y-1.5 border-t border-blue-200 pt-3 first:border-t-0 first:pt-0 dark:border-blue-900">
          <Lines lines={s.lines} />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-neutral-500">{SUGGESTION_NOTES.confirmed}</span>
            {canEdit ? (
              <Button className="text-xs" disabled={busy !== null} onClick={() => void decide(s, "undo")}>
                {busy === `${s.id}:undo` ? "Undoing…" : "Undo"}
              </Button>
            ) : null}
          </div>
        </div>
      ))}
      {error ? <Banner tone="err">{error}</Banner> : null}
    </section>
  );
}
