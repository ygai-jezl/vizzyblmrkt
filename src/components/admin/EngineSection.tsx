"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * A launch's "Email engine" panel (engine move D5): where its welcome emails run
 * — the original engine or the lifecycle engine — and the steps to move them:
 * a dry run, an optional shadow rehearsal, the switch, and a way back. Admins
 * only; counts only.
 */

type Engine = "legacy" | "rehearsal" | "lifecycle";
type Issue = { code: string; message: string; nodeId?: string };
interface Status {
  engine: Engine;
  since: string | null;
  history: Array<{ engine: Engine; at: string; by: string | null }>;
  enabled: boolean;
  pilot: boolean;
  doubleSends: number;
  originalRetired: boolean;
  preview: {
    original: { exists: boolean; status: string | null; emails: number; peopleInJourney: number };
    verifiedSignups: number;
    lifecycle: { journeyId: string; exists: boolean; status: string | null };
    conversion: { ok: boolean; blocking: Issue[]; notes: Issue[] } | null;
    converted: { emails: number; abTests: number } | null;
  };
}

const ENGINE_LABEL: Record<Engine, string> = {
  legacy: "The original engine",
  rehearsal: "The original engine, with a rehearsal on the new one",
  lifecycle: "The new (lifecycle) engine",
};

const ERRORS: Record<string, string> = {
  engine_off: "The new engine is switched off in this environment.",
  not_in_pilot: "Moving launches isn't open to this account yet.",
  launch_archived: "Restore the launch first.",
  journey_paused: "Turn the welcome emails back on first, so nobody is left waiting.",
  cannot_convert: "This journey can't be moved as it is — see what's blocking it below.",
  nothing_to_rehearse: "There's nothing to rehearse: the welcome journey hasn't been published.",
  no_shadow_inbox: "Your account has no email address to send the rehearsal to.",
  already_moved: "This launch has already moved.",
};

const BUTTON =
  "rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900";
const PRIMARY =
  "rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900";

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");

export function EngineSection({ campaignId }: { campaignId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/campaigns/${campaignId}/engine`);
    if (res.ok) setStatus((await res.json()) as Status);
  }, [campaignId]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: "rehearse" | "end_rehearsal" | "switch" | "rollback", confirmText: string, done: string) => {
    if (!window.confirm(confirmText)) return;
    setBusy(action);
    setMsg(null);
    const res = await fetch(`/api/admin/campaigns/${campaignId}/engine`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; status?: Status };
    setBusy(null);
    if (!res.ok) return setMsg({ ok: false, text: ERRORS[data.error ?? ""] ?? "That didn't work — please try again." });
    if (data.status) setStatus(data.status);
    setMsg({ ok: true, text: done });
    router.refresh();
  };

  if (!status) return null;
  const p = status.preview;
  const conversion = p.conversion;
  const canMove = status.enabled && status.pilot;

  return (
    <section className="mt-8 space-y-3 rounded-md border border-neutral-200 p-5 dark:border-neutral-800">
      <div>
        <h2 className="text-sm font-semibold">Email engine</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Welcome emails run on: <span className="font-medium text-neutral-800 dark:text-neutral-200">{ENGINE_LABEL[status.engine]}</span>
          {status.engine === "lifecycle" && status.since ? ` since ${day(status.since)}` : ""}.
        </p>
      </div>

      {status.engine === "lifecycle" ? (
        <ul className="space-y-1 text-sm text-neutral-600 dark:text-neutral-400">
          <li>
            {status.originalRetired || p.original.peopleInJourney === 0
              ? "Nobody is left on the original engine."
              : `${p.original.peopleInJourney.toLocaleString("en-GB")} ${p.original.peopleInJourney === 1 ? "person is" : "people are"} finishing on the original engine.`}
          </li>
          <li>
            {status.doubleSends === 0
              ? "No one has had emails from both engines."
              : `${status.doubleSends} ${status.doubleSends === 1 ? "person has" : "people have"} had emails from both engines — check before going further.`}
          </li>
        </ul>
      ) : (
        <div className="space-y-2 text-sm">
          {conversion ? (
            conversion.ok ? (
              <p className="text-neutral-600 dark:text-neutral-400">
                Its welcome journey moves cleanly: {p.converted?.emails ?? 0} emails
                {p.converted?.abTests ? `, ${p.converted.abTests} A/B test${p.converted.abTests === 1 ? "" : "s"}` : ""}. People part-way
                through ({p.original.peopleInJourney.toLocaleString("en-GB")}) finish on the original engine; new signups get the new one.
              </p>
            ) : (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
                <p className="font-medium">It can&rsquo;t move yet:</p>
                <ul className="mt-1 list-disc pl-5">
                  {conversion.blocking.map((b, i) => (
                    <li key={i}>{b.message}</li>
                  ))}
                </ul>
              </div>
            )
          ) : (
            <p className="text-neutral-600 dark:text-neutral-400">It has no welcome journey yet: after the switch you build it in the new editor.</p>
          )}
          {conversion?.notes.length ? (
            <details className="text-xs text-neutral-500">
              <summary className="cursor-pointer">Notes</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {conversion.notes.map((n, i) => (
                  <li key={i}>{n.message}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      )}

      {msg ? <p className={`text-sm ${msg.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>{msg.text}</p> : null}

      <div className="flex flex-wrap gap-2">
        {status.engine === "legacy" && p.original.status === "active" && conversion?.ok ? (
          <button
            type="button"
            className={BUTTON}
            disabled={!canMove || busy !== null}
            onClick={() =>
              void act(
                "rehearse",
                "Rehearse on the new engine? New signups also go through the new journey in shadow: every email goes to your own inbox, never to them. The original engine keeps emailing them as normal.",
                "Rehearsing. New signups' emails from the new engine come to your inbox.",
              )
            }
          >
            {busy === "rehearse" ? "Starting…" : "Rehearse first"}
          </button>
        ) : null}
        {status.engine === "rehearsal" ? (
          <button
            type="button"
            className={BUTTON}
            disabled={busy !== null}
            onClick={() => void act("end_rehearsal", "End the rehearsal? Its shadow emails stop.", "Rehearsal ended.")}
          >
            End rehearsal
          </button>
        ) : null}
        {status.engine !== "lifecycle" && (conversion?.ok || !p.original.exists || p.original.status === "draft") ? (
          <button
            type="button"
            className={PRIMARY}
            disabled={!canMove || busy !== null}
            onClick={() =>
              void act(
                "switch",
                "Switch to the new engine? New signups get only the new engine's emails from now on. People part-way through finish on the original.",
                "Switched. New signups now get the new engine's emails.",
              )
            }
          >
            {busy === "switch" ? "Switching…" : "Switch to the new engine"}
          </button>
        ) : null}
        {status.engine === "lifecycle" ? (
          <>
            <a href={`/admin/lifecycle/${p.lifecycle.journeyId}`} className={BUTTON}>
              Open the welcome journey
            </a>
            <button
              type="button"
              className={BUTTON}
              disabled={busy !== null}
              onClick={() =>
                void act(
                  "rollback",
                  "Switch back? New signups go back to the original engine. People already on the new engine finish there.",
                  "Switched back. New signups get the original engine's emails again.",
                )
              }
            >
              Switch back
            </button>
          </>
        ) : null}
      </div>
      {!canMove && status.engine !== "lifecycle" ? (
        <p className="text-xs text-neutral-500">
          {status.enabled ? "Moving launches isn't open to this account yet." : "The new engine is switched off in this environment."}
        </p>
      ) : null}

      {status.history.length ? (
        <details className="text-xs text-neutral-500">
          <summary className="cursor-pointer">History</summary>
          <ul className="mt-1 space-y-0.5">
            {[...status.history].reverse().map((h, i) => (
              <li key={i}>
                {day(h.at)} · {ENGINE_LABEL[h.engine]}
                {h.by ? ` · ${h.by}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
