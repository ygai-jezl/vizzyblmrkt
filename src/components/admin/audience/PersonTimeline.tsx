"use client";

import { useCallback, useEffect, useState } from "react";
import type { TimelineEntry, TimelineViewPage } from "@/lib/audience/personTimelineView";
import { api } from "../connect/api";
import { Banner, Button, Section } from "../connect/ui";
import { day, dayTime } from "../people/format";
import { VoiceChatDialog } from "./VoiceChatDialog";

/**
 * The timeline on a person's page (AUDIENCE_TIMELINE_ENABLED), newest first: being added, consent,
 * field changes, stage and launch moves, sign-ups, launch emails and voice chats. Older entries
 * load on request. Each product's own story stays on its part of the page.
 */

const DOT: Record<TimelineEntry["kind"], string> = {
  created: "bg-neutral-400",
  consent: "bg-green-500",
  field: "bg-blue-500",
  stage: "bg-amber-500",
  product: "bg-amber-500",
  quiet: "bg-amber-500",
  launch: "bg-neutral-400",
  agent: "bg-violet-500",
  signup: "bg-neutral-400",
  email: "bg-sky-500",
  voice_chat: "bg-violet-500",
};

export const TIMELINE_EMPTY = "Nothing here yet. Moves are recorded from the day the timeline was turned on.";

export function PersonTimeline({ personId, canEdit }: { personId: string; canEdit: boolean }) {
  const [entries, setEntries] = useState<TimelineEntry[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reading, setReading] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: string | null) => {
      const r = await api<TimelineViewPage>(`/api/admin/audience/everyone/${encodeURIComponent(personId)}/timeline${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!r.ok) return setFailed(true);
      setEntries((cur) => (cursor ? [...(cur ?? []), ...r.data.entries] : r.data.entries));
      setNext(r.data.next);
    },
    [personId],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  async function older() {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    await load(next);
    setLoadingMore(false);
  }

  return (
    <Section title="Timeline">
      {failed ? (
        <Banner tone="err">Couldn&rsquo;t load the timeline. Reload the page to try again.</Banner>
      ) : !entries ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-neutral-500">{TIMELINE_EMPTY}</p>
      ) : (
        <ol className="space-y-3 text-sm">
          {entries.map((e) => (
            <li key={e.id} className="grid grid-cols-[5.5rem_0.75rem_minmax(0,1fr)] items-start gap-2">
              <span className="text-xs text-neutral-500" title={dayTime(e.at)}>
                {day(e.at)}
              </span>
              <span aria-hidden className={`mt-1.5 h-2 w-2 rounded-full ${DOT[e.kind]}`} />
              <div className="min-w-0 break-words">
                <div>{e.text}</div>
                {e.kind === "voice_chat" && e.signupId && canEdit ? (
                  <button type="button" className="text-xs underline underline-offset-2" onClick={() => setReading(e.signupId!)}>
                    Read the conversation
                  </button>
                ) : e.detail ? (
                  <div className="text-xs text-neutral-500">{e.detail}</div>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
      {next && !failed ? (
        <Button onClick={() => void older()} disabled={loadingMore}>
          {loadingMore ? "Loading…" : "Show older"}
        </Button>
      ) : null}
      {reading ? <VoiceChatDialog personId={personId} signupId={reading} onClose={() => setReading(null)} /> : null}
    </Section>
  );
}
