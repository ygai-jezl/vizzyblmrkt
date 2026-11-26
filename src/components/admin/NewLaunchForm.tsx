"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  defaultCampaignSettings,
  slugifyCampaignId,
  type CampaignSettings,
} from "@/lib/admin/campaignSettings";
import { IDEA_LIMITS, type RequiredContactDetail } from "@/lib/types/campaign";
import { ideaMessages } from "@/lib/ideas/words";
import { ideaWord } from "@/lib/nav/terms";
import { WORK_COPY } from "@/lib/work/screenWords";
import { useWords } from "./nav/WordsProvider";

const CONTACT_OPTIONS: RequiredContactDetail[] = ["EMAIL", "PHONE", "BOTH", "EITHER"];

/**
 * Minimal "create a launch" form: capture the name (+ a few key knobs) and POST
 * to /api/admin/campaigns with defaults filled in. On success, jump straight to
 * the new launch workspace where the full Settings editor lives.
 *
 * With `hypothesis` (LAUNCH_IDEAS_ENABLED, admins only) it also asks for the idea's
 * hypothesis, saved by a second call once the launch exists. If that call fails the
 * launch is made all the same: the form stays, with the text kept, and says so.
 *
 * With the words on (useWords().ideas) it names an idea instead. "Launch name is required." and
 * its idea twin are written out, since the help page quotes them.
 *
 * From Work's Make it an idea (`workTask`, WORK_ENABLED, worked out on the server), the name starts
 * as the task's title and, once the launch exists, the task is linked to it (PATCH the task with
 * the idea). If that link fails the launch is made all the same: the form says so and offers Link
 * the task, which sends the same link again.
 */
export function NewLaunchForm({
  hypothesis: withHypothesis = false,
  initialName = "",
  workTask = null,
}: {
  hypothesis?: boolean;
  initialName?: string;
  workTask?: { ref: number; brandId: string } | null;
}) {
  const router = useRouter();
  const { ideas } = useWords();
  const w = ideaWord(ideas);
  const [name, setName] = useState(initialName);
  const [hypothesis, setHypothesis] = useState("");
  const [madeId, setMadeId] = useState<string | null>(null);
  const [linkFailed, setLinkFailed] = useState(false);
  const [hypothesisFailed, setHypothesisFailed] = useState(false);
  const [linking, setLinking] = useState(false);
  const [slug, setSlug] = useState("");
  const [contact, setContact] = useState<RequiredContactDetail>("EMAIL");
  const [verify, setVerify] = useState(false);
  const [leaderboard, setLeaderboard] = useState(true);
  const [spots, setSpots] = useState(10);
  const [status, setStatus] = useState<"idle" | "creating" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const finalSlug = slugifyCampaignId(slug || name);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError(ideas ? "Idea name is required." : "Launch name is required.");
      setStatus("error");
      return;
    }
    setStatus("creating");
    setError(null);

    const settings: CampaignSettings = {
      ...defaultCampaignSettings(),
      waitlistName: name.trim(),
      requiredContactDetail: contact,
      usesSignupVerification: verify,
      usesLeaderboard: leaderboard,
      spotsToMoveUponReferral: Number.isFinite(spots) ? Math.max(0, Math.min(1000, spots)) : 10,
    };

    const res = await fetch("/api/admin/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: slug.trim() || undefined, settings }),
    });

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      // The server's id_taken message names a launch.
      setError(
        ideas && data.error === "id_taken"
          ? "An idea already uses that URL slug. Pick another one."
          : (data.message ?? data.error ?? `Could not create the ${w.one}. Please try again.`),
      );
      setStatus("error");
      return;
    }

    const { id } = (await res.json()) as { id: string };
    // Work's task is linked to the launch it became; the launch stands either way.
    const linked = await linkTask(id);
    if (!linked) setLinkFailed(true);
    if (withHypothesis && hypothesis.trim()) {
      const saved = await fetch(`/api/admin/campaigns/${encodeURIComponent(id)}/idea`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hypothesis }),
      }).then((r) => r.ok, () => false);
      if (!saved) {
        setHypothesisFailed(true);
        setMadeId(id);
        setStatus("idle");
        return;
      }
    }
    if (!linked) {
      setMadeId(id);
      setStatus("idle");
      return;
    }
    router.push(`/admin/launches/${id}`);
    router.refresh();
  }

  /** Link Work's task to the launch: the same PATCH on the first try and on Link the task. */
  async function linkTask(id: string): Promise<boolean> {
    if (!workTask) return true;
    return fetch(`/api/admin/work/tasks/${workTask.ref}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idea: { brandId: workTask.brandId, ideaId: id }, via: "work_page" }),
    }).then((r) => r.ok, () => false);
  }

  async function linkAgain() {
    if (!madeId) return;
    setLinking(true);
    const linked = await linkTask(madeId);
    setLinking(false);
    if (!linked) return;
    setLinkFailed(false);
    if (hypothesisFailed) return;
    router.push(`/admin/launches/${madeId}`);
    router.refresh();
  }

  const busy = status === "creating";

  return (
    <form onSubmit={submit} className="space-y-5">
      <Field label={`${w.One} name`} hint="Shown on the hosted waitlist page.">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={ideas ? "Developer API" : "Developer API Launch"}
          required
          disabled={madeId !== null}
          className={inputClass}
        />
      </Field>

      {withHypothesis ? (
        <label className="block space-y-1">
          <span className="text-sm font-medium">
            Hypothesis <span className="font-normal text-neutral-500">(optional)</span>
          </span>
          <textarea
            rows={3}
            maxLength={IDEA_LIMITS.hypothesis}
            value={hypothesis}
            onChange={(e) => setHypothesis(e.target.value)}
            placeholder="Plant owners will pay each month for a box of care supplies."
            disabled={madeId !== null}
            className={inputClass}
          />
          <span className="flex justify-between gap-3 text-xs text-neutral-400">
            <span>What you expect to happen, and for whom. You can change it on the Overview later.</span>
            <span className="shrink-0 tabular-nums">
              {hypothesis.length.toLocaleString("en-GB")} of {IDEA_LIMITS.hypothesis.toLocaleString("en-GB")}
            </span>
          </span>
        </label>
      ) : null}

      <Field
        label="URL slug"
        hint={
          finalSlug
            ? `Public page: /waitlist/${finalSlug}`
            : "Leave blank to auto-generate from the name."
        }
      >
        <input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder={slugifyCampaignId(name) || "developer-api-launch"}
          disabled={madeId !== null}
          className={inputClass}
        />
      </Field>

      <Field label="Required contact detail">
        <select
          value={contact}
          onChange={(e) => setContact(e.target.value as RequiredContactDetail)}
          disabled={madeId !== null}
          className={inputClass}
        >
          {CONTACT_OPTIONS.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Spots skipped per referral">
        <input
          type="number"
          min={0}
          max={1000}
          value={spots}
          onChange={(e) => setSpots(e.target.valueAsNumber)}
          disabled={madeId !== null}
          className={inputClass}
        />
      </Field>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={leaderboard} disabled={madeId !== null} onChange={(e) => setLeaderboard(e.target.checked)} />
        Show a public leaderboard
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={verify} disabled={madeId !== null} onChange={(e) => setVerify(e.target.checked)} />
        Require email verification (double opt-in)
      </label>

      {error ? (
        <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          {error}
        </p>
      ) : null}

      {madeId ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <p>{linkFailed ? (ideas ? WORK_COPY.ideaLinkFailed : WORK_COPY.launchLinkFailed) : ideaMessages(ideas).hypothesisNotSaved}</p>
          <div className="flex flex-wrap items-center gap-2">
            {linkFailed ? (
              <button
                type="button"
                onClick={() => void linkAgain()}
                disabled={linking}
                className="rounded-md border border-amber-400 px-3 py-1.5 text-sm font-medium hover:bg-amber-100 disabled:opacity-60 dark:border-amber-800 dark:hover:bg-amber-900/40"
              >
                {WORK_COPY.linkTaskAgain}
              </button>
            ) : null}
            <Link
              href={`/admin/launches/${madeId}`}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              Open its Overview
            </Link>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            {busy ? "Creating…" : `Create ${w.one}`}
          </button>
          <span className="text-xs text-neutral-400">You can fine-tune everything else in the {w.own} Settings tab.</span>
        </div>
      )}
    </form>
  );
}

const inputClass =
  "w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-neutral-400">{hint}</span> : null}
    </label>
  );
}
