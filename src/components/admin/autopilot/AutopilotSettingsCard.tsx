"use client";

import { useEffect, useState } from "react";
import { MAX_PER_WEEK, type AutopilotSettings } from "@/lib/types/autopilot";

/**
 * Autopilot on Brand › Brand map (CREATE_ARTICLE_AUTOPILOT_ENABLED): whether it runs (Off, Suggest,
 * Draft), when, what to focus on, which programme and channels a draft goes into, and this month's
 * lookups and drafts. Admins change it; everyone sees it. /help/brand-map#autopilot explains it.
 */

interface Data {
  settings: AutopilotSettings;
  canDraft: boolean;
  programmes: Array<{ id: string; name: string }>;
  month: { lookups: number; lookupLimit: number; drafts: number; draftLimit: number };
}

const CARD = "rounded-lg border border-neutral-200 p-4 dark:border-neutral-800";
const HINT = "text-xs text-neutral-500 dark:text-neutral-400";
const FIELD = "mt-1 block w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900";
const LABEL = "text-xs font-medium text-neutral-600 dark:text-neutral-300";
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const CHANNELS: Array<{ id: AutopilotSettings["channels"][number]; name: string }> = [
  { id: "linkedin", name: "LinkedIn" },
  { id: "x", name: "X" },
  { id: "instagram", name: "Instagram" },
];
const MODES: Array<{ id: AutopilotSettings["mode"]; name: string; hint: string }> = [
  { id: "off", name: "Off", hint: "Nothing runs on its own. Next up still works when you open it." },
  { id: "suggest", name: "Suggest", hint: "Picks the next article, finds and sorts what buyers ask, then waits for you." },
  { id: "draft", name: "Draft", hint: "Also writes the article, its teaser, its promo and a post per channel. All of it waits in Review; nothing is published." },
];

const ERRORS: Record<string, string> = {
  not_included: "Draft isn't part of this brand's plan. Suggest is.",
  programme_required: "Choose the programme drafts go into.",
  forbidden: "Only admins can change Autopilot.",
};

export function AutopilotSettingsCard({ isAdmin }: { isAdmin: boolean }) {
  const [data, setData] = useState<Data | null>(null);
  const [draft, setDraft] = useState<AutopilotSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    void fetch("/api/admin/brand-kit/autopilot/settings")
      .then((r) => (r.ok ? (r.json() as Promise<Data>) : null))
      .then((d) => {
        if (gone || !d) return;
        setData(d);
        setDraft(d.settings);
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, []);

  if (!data || !draft) return null;
  const set = (patch: Partial<AutopilotSettings>) => setDraft({ ...draft, ...patch });
  const locked = !isAdmin || busy;

  const save = async () => {
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/admin/brand-kit/autopilot/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    }).catch(() => null);
    const body = res ? ((await res.json().catch(() => ({}))) as { settings?: AutopilotSettings; error?: string }) : {};
    setBusy(false);
    if (res?.ok && body.settings) {
      setData({ ...data, settings: body.settings });
      setMessage("Saved.");
      return;
    }
    setMessage(ERRORS[body.error ?? ""] ?? "That didn't save. Try again in a moment.");
  };

  const changed = JSON.stringify(draft) !== JSON.stringify(data.settings);
  return (
    <section className={CARD} aria-labelledby="autopilot">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="autopilot" className="text-sm font-semibold">
          Autopilot
        </h2>
        <span className={HINT}>
          This month: {data.month.lookups} of {data.month.lookupLimit} Google lookups, {data.month.drafts} of {data.month.draftLimit} drafts
        </span>
      </div>
      <div className="space-y-3">
        <div role="radiogroup" aria-label="Runs" className="flex flex-wrap gap-2">
          {MODES.map((m) => {
            const disabled = locked || (m.id === "draft" && !data.canDraft);
            return (
              <label key={m.id} className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs ${draft.mode === m.id ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40" : "border-neutral-300 dark:border-neutral-700"} ${disabled ? "opacity-50" : ""}`}>
                <input type="radio" name="autopilot-mode" value={m.id} checked={draft.mode === m.id} disabled={disabled} onChange={() => set({ mode: m.id })} />
                {m.name}
              </label>
            );
          })}
        </div>
        <p className={HINT}>{MODES.find((m) => m.id === draft.mode)?.hint}</p>
        {!data.canDraft ? <p className={HINT}>{ERRORS.not_included}</p> : null}
        <div className="grid gap-3 sm:grid-cols-3">
          <label className={LABEL}>
            On
            <select value={draft.weekday} disabled={locked} onChange={(e) => set({ weekday: Number(e.target.value) })} className={FIELD}>
              {DAYS.map((d, i) => (
                <option key={d} value={i + 1}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label className={LABEL}>
            Articles a week
            <select value={draft.perWeek} disabled={locked} onChange={(e) => set({ perWeek: Number(e.target.value) })} className={FIELD}>
              {Array.from({ length: MAX_PER_WEEK }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className={LABEL}>
            Drafts go into
            <select value={draft.workspaceId ?? ""} disabled={locked} onChange={(e) => set({ workspaceId: e.target.value || null })} className={FIELD}>
              <option value="">{data.programmes.length === 1 ? data.programmes[0]!.name : "Choose a programme"}</option>
              {data.programmes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className={`block ${LABEL}`}>
          Your focus right now
          <input
            value={draft.focus}
            maxLength={200}
            disabled={locked}
            placeholder="What you want more of, such as more agencies this quarter"
            onChange={(e) => set({ focus: e.target.value })}
            className={FIELD}
          />
        </label>
        <fieldset className="flex flex-wrap items-center gap-3 text-xs" disabled={locked}>
          <legend className={`mb-1 ${LABEL}`}>Posts for</legend>
          {CHANNELS.map((c) => (
            <label key={c.id} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={draft.channels.includes(c.id)}
                onChange={(e) => set({ channels: e.target.checked ? [...draft.channels, c.id] : draft.channels.filter((x) => x !== c.id) })}
              />
              {c.name}
            </label>
          ))}
        </fieldset>
        {draft.mode === "draft" && draft.perWeek * 4 > data.month.draftLimit ? (
          <p className={HINT}>
            At {draft.perWeek} a week, this brand reaches its {data.month.draftLimit} drafts a month. After that, runs find and sort the
            article for you to write instead.
          </p>
        ) : null}
        <p className={HINT}>It reads your brand map, what you made (brand search), what competitors wrote and Google. Nothing is ever published: drafts wait in Review.</p>
        {isAdmin ? (
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !changed}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        ) : (
          <p className={HINT}>Only admins can change Autopilot.</p>
        )}
        {message ? (
          <p className={HINT} aria-live="polite">
            {message}
          </p>
        ) : null}
      </div>
    </section>
  );
}
