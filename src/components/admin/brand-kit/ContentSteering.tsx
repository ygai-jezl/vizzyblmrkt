"use client";

import { useState } from "react";
import { RotateCcw, Play, Lock, TrendingUp, TrendingDown, Sparkles } from "lucide-react";
import type { ChannelSteeringState } from "@/lib/distribute/feedback/steeringState";
import type { LearnedPatternVersion } from "@/lib/types/learnedPatternVersion";

const CHANNEL_LABEL: Record<string, string> = {
  linkedin: "LinkedIn",
  x: "X",
  instagram: "Instagram",
};

function pct(n: number): string {
  const v = Math.round(n * 100);
  return `${v >= 0 ? "+" : ""}${v}%`;
}

function fmtDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function ContentSteering({ initialChannels }: { initialChannels: ChannelSteeringState[] }) {
  const [channels, setChannels] = useState(initialChannels);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch("/api/admin/brand-kit/steering", { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as { channels: ChannelSteeringState[] };
      setChannels(data.channels);
    }
  }

  async function act(channel: string, body: Record<string, unknown>, key: string) {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(`/api/admin/brand-kit/steering/${channel}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(j?.error ?? "action_failed");
      } else {
        await refresh();
      }
    } catch {
      setError("network_error");
    } finally {
      setBusy(null);
    }
  }

  if (channels.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-200 p-8 text-center text-sm text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
        <Sparkles size={22} className="mx-auto mb-2 text-neutral-400" />
        Nothing learned yet. Once your published posts accumulate enough proven, repeatable
        performance, the AI will start steering new posts — and every change will show up here with
        its reasoning and the posts behind it.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}
      {channels.map((c) => (
        <ChannelCard key={c.channel} state={c} busy={busy} onAct={act} />
      ))}
    </div>
  );
}

function ChannelCard({
  state,
  busy,
  onAct,
}: {
  state: ChannelSteeringState;
  busy: string | null;
  onAct: (channel: string, body: Record<string, unknown>, key: string) => void;
}) {
  return (
    <section className="rounded-xl border border-neutral-200 dark:border-neutral-800">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">{CHANNEL_LABEL[state.channel] ?? state.channel}</h2>
          <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
            v{state.activeVersion} · {state.sampleCount} proven posts
          </span>
        </div>
        {state.frozen ? (
          <button
            onClick={() => onAct(state.channel, { action: "resume" }, `resume:${state.channel}`)}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            <Play size={13} /> Resume learning
          </button>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Learning
          </span>
        )}
      </header>

      <div className="space-y-4 px-4 py-4">
        {state.frozen && (
          <div className="flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            <Lock size={13} /> Pinned to v{state.pinnedVersion}. Auto-learning is paused until you resume.
          </div>
        )}

        {state.directive ? (
          <p className="rounded-lg bg-neutral-50 p-3 text-sm leading-relaxed dark:bg-neutral-900">
            {state.directive}
          </p>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">No directive yet for this channel.</p>
        )}

        {(state.perform.length > 0 || state.avoid.length > 0) && (
          <div className="grid gap-4 sm:grid-cols-2">
            {state.perform.length > 0 && (
              <div>
                <div className="mb-1.5 flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  <TrendingUp size={13} /> What performs
                </div>
                <ul className="space-y-1.5">
                  {state.perform.map((r, i) => (
                    <li key={i} className="flex items-start justify-between gap-2 text-sm">
                      <span>{r.text}</span>
                      <span className="shrink-0 text-[11px] text-neutral-400">
                        {r.support} · {pct(r.meanLift)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {state.avoid.length > 0 && (
              <div>
                <div className="mb-1.5 flex items-center gap-1 text-xs font-medium text-rose-600 dark:text-rose-400">
                  <TrendingDown size={13} /> What to avoid
                </div>
                <ul className="space-y-1.5">
                  {state.avoid.map((r, i) => (
                    <li key={i} className="text-sm">
                      {r.text}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <VersionTimeline state={state} busy={busy} onAct={onAct} />
      </div>
    </section>
  );
}

function VersionTimeline({
  state,
  busy,
  onAct,
}: {
  state: ChannelSteeringState;
  busy: string | null;
  onAct: (channel: string, body: Record<string, unknown>, key: string) => void;
}) {
  if (state.versions.length === 0) return null;
  return (
    <div>
      <div className="mb-2 text-xs font-medium text-neutral-500 dark:text-neutral-400">
        How the AI got here
      </div>
      <ol className="space-y-3">
        {state.versions.map((v: LearnedPatternVersion) => {
          const isActive = v.version === state.activeVersion;
          const key = `revert:${state.channel}:${v.version}`;
          return (
            <li
              key={v.version}
              className={`rounded-lg border p-3 text-sm ${
                isActive
                  ? "border-neutral-900 dark:border-neutral-100"
                  : "border-neutral-200 dark:border-neutral-800"
              }`}
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">v{v.version}</span>
                  {isActive && (
                    <span className="rounded-full bg-neutral-900 px-1.5 py-0.5 text-[10px] font-medium text-white dark:bg-neutral-100 dark:text-neutral-900">
                      Live
                    </span>
                  )}
                  {v.createdBy === "revert" && (
                    <span className="text-[11px] text-neutral-400">reverted</span>
                  )}
                  <span className="text-[11px] text-neutral-400">{fmtDate(v.createdAt)}</span>
                </div>
                {!isActive && (
                  <button
                    onClick={() => onAct(state.channel, { action: "revert", toVersion: v.version }, key)}
                    disabled={busy !== null}
                    className="inline-flex items-center gap-1 rounded-md border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
                  >
                    <RotateCcw size={11} /> {busy === key ? "…" : "Revert here"}
                  </button>
                )}
              </div>
              {v.judgeRationale && (
                <p className="text-neutral-600 dark:text-neutral-300">{v.judgeRationale}</p>
              )}
              {v.evidence.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {v.evidence.slice(0, 6).map((e, i) => (
                    <span
                      key={i}
                      className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
                    >
                      {e.support} posts · {pct(e.meanLift)}
                    </span>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
