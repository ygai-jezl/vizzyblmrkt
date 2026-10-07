"use client";

import { useState } from "react";
import Link from "next/link";
import { continuesFromId, JOURNEY_COMPLETED_EVENT, startsAfterJourney, type LifecycleSettings } from "@/lib/types/lifecycle";
import { api, errorText } from "../connect/api";
import { Badge, Button, Field, inputClass } from "../connect/ui";
import type { JourneyChain } from "./model";

/**
 * Journey links (LIFECYCLE_JOURNEY_LINKS_ENABLED): one journey continuing from
 * another. The link is ONE setting — the later journey's "Starts when" — shown
 * at both ends:
 *  - `ContinuesFromField`, at a journey's start (Settings and the canvas's
 *    Trigger): which journey this one continues from. Saved with the draft.
 *  - `ContinuesToList`, at a journey's End: the journeys that continue from this
 *    one, and a picker that makes another journey do so (in that journey's draft).
 * Either way it goes live when the LATER journey is published; the earlier one
 * never needs republishing, and people part-way through it carry on.
 */

const STATUS: Record<string, string> = { draft: "draft", active: "live", paused: "paused", archived: "archived" };

/** `settings` continuing from `afterJourneyId` — or, with null, starting on sign-up again. */
export function withContinuesFrom(settings: LifecycleSettings, afterJourneyId: string | null): LifecycleSettings {
  return {
    ...settings,
    trigger: afterJourneyId
      ? { ...settings.trigger, event: JOURNEY_COMPLETED_EVENT, afterJourneyId }
      : { ...settings.trigger, event: "user.signed_up", afterJourneyId: null },
  };
}

export function ContinuesFromField({
  settings,
  chain,
  readOnly,
  onChange,
}: {
  settings: LifecycleSettings;
  chain: JourneyChain;
  readOnly: boolean;
  onChange: (next: LifecycleSettings) => void;
}) {
  const chosen = continuesFromId(settings);
  const waiting = startsAfterJourney(settings) && !chosen;
  const from = chain.journeys.find((j) => j.id === chosen);
  // Not a journey that continues from this one: the two would lead back into each other.
  const follows = new Set(chain.next.filter((n) => n.draft).map((n) => n.id));
  const options = chain.journeys.filter((j) => j.id === chosen || !follows.has(j.id));
  return (
    <div className="space-y-1.5">
      <Field label="Continues from" hint={chosen || waiting ? undefined : "Pick a journey to start this one when someone finishes it, instead of on a product event."}>
        <select
          className={inputClass}
          value={chosen ?? ""}
          disabled={readOnly}
          onChange={(e) => onChange(withContinuesFrom(settings, e.target.value || null))}
        >
          <option value="">Nothing — a product event starts it</option>
          {options.map((j) => (
            <option key={j.id} value={j.id}>
              {j.name} · {STATUS[j.status] ?? j.status}
            </option>
          ))}
          {chosen && !from ? <option value={chosen}>A journey that&rsquo;s gone</option> : null}
        </select>
      </Field>
      {from ? (
        <p className="text-xs text-neutral-500">
          People enter when they reach the end of{" "}
          <Link className="underline" href={`/admin/lifecycle/${from.id}`}>
            {from.name}
          </Link>
          {from.timeline ? <>, which sends {from.timeline.text}</> : null}. This journey&rsquo;s waits count from that moment, not from sign-up.
          {from.status !== "active" ? " Nobody finishes it until it's live." : ""}
        </p>
      ) : null}
      {waiting ? <p className="text-xs text-red-600">Choose the journey this one continues from.</p> : null}
    </div>
  );
}

export function ContinuesToList({
  journeyId,
  chain,
  readOnly,
  onLinked,
}: {
  journeyId: string;
  chain: JourneyChain;
  readOnly: boolean;
  /** Another journey now continues from this one (its draft changed): reload the links. */
  onLinked: () => void;
}) {
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const linked = new Set(chain.next.filter((n) => n.draft).map((n) => n.id));
  // Not the journey this one continues from: the two would lead back into each other.
  const candidates = chain.journeys.filter((j) => !linked.has(j.id) && j.id !== chain.from?.id);
  const target = candidates.find((j) => j.id === pick);

  const link = async () => {
    if (!target) return;
    const starts = target.continuesFrom
      ? "It continues from another journey today; it will continue from this one instead."
      : "It starts on a product event today; it will start when someone finishes this journey instead.";
    if (!window.confirm(`Make "${target.name}" continue from this journey?\n\n${starts}\n\nThis changes its draft. It goes live when you publish "${target.name}".`)) return;
    setBusy(true);
    setErr(null);
    const r = await api(`/api/admin/lifecycle/journeys/${journeyId}/next`, { method: "POST", body: JSON.stringify({ nextJourneyId: target.id }) });
    setBusy(false);
    if (!r.ok) return setErr(errorText(r.data));
    setPick("");
    onLinked();
  };

  return (
    <div className="space-y-2">
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Then continue to</span>
      {chain.next.length === 0 ? (
        <p className="text-sm text-neutral-500">Nothing yet — the sequence ends here.</p>
      ) : (
        <ul className="space-y-1.5">
          {chain.next.map((n) => (
            <li key={n.id} className="space-y-0.5 text-sm">
              <div className="flex flex-wrap items-center gap-1.5">
                <Link className="underline" href={`/admin/lifecycle/${n.id}`}>
                  {n.name}
                </Link>
                {n.live ? <Badge tone="green">live</Badge> : n.published ? <Badge tone="amber">{n.status}</Badge> : <Badge tone="amber">not live yet</Badge>}
              </div>
              <p className="text-xs text-neutral-500">
                {n.live && n.draft
                  ? "People who reach this end go on to it."
                  : n.live
                    ? "People who reach this end go on to it. Its draft starts another way: that takes over when it's published."
                    : n.published
                      ? "It's set to follow this journey, but it isn't active."
                      : "Set in its draft. Publish it to switch this on."}
              </p>
            </li>
          ))}
        </ul>
      )}
      {!readOnly && candidates.length > 0 ? (
        <div className="space-y-1.5">
          <select className={inputClass} value={pick} disabled={busy} onChange={(e) => setPick(e.target.value)} aria-label="Continue to another journey">
            <option value="">Continue to another journey…</option>
            {candidates.map((j) => (
              <option key={j.id} value={j.id}>
                {j.name} · {STATUS[j.status] ?? j.status}
              </option>
            ))}
          </select>
          {target ? (
            <Button disabled={busy} onClick={() => void link()}>
              {busy ? "Linking…" : `Continue to ${target.name}`}
            </Button>
          ) : null}
        </div>
      ) : null}
      {err ? <p className="text-xs text-red-600">{err}</p> : null}
      <p className="text-xs text-neutral-500">
        Only people who reach the end go on — not anyone who unsubscribed or was stopped. To change or remove a link, open the next journey&rsquo;s Settings
        (Starts when).
      </p>
    </div>
  );
}
