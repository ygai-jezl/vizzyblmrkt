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
import { IDEA_MESSAGES } from "@/lib/ideas/words";

const CONTACT_OPTIONS: RequiredContactDetail[] = ["EMAIL", "PHONE", "BOTH", "EITHER"];

/**
 * Minimal "create a launch" form: capture the name (+ a few key knobs) and POST
 * to /api/admin/campaigns with defaults filled in. On success, jump straight to
 * the new launch workspace where the full Settings editor lives.
 *
 * With `hypothesis` (LAUNCH_IDEAS_ENABLED, admins only) it also asks for the idea's
 * hypothesis, saved by a second call once the launch exists. If that call fails the
 * launch is made all the same: the form stays, with the text kept, and says so.
 */
export function NewLaunchForm({ hypothesis: withHypothesis = false }: { hypothesis?: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [madeId, setMadeId] = useState<string | null>(null);
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
      setError("Launch name is required.");
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
      setError(data.message ?? data.error ?? "Could not create the launch. Please try again.");
      setStatus("error");
      return;
    }

    const { id } = (await res.json()) as { id: string };
    if (withHypothesis && hypothesis.trim()) {
      const saved = await fetch(`/api/admin/campaigns/${encodeURIComponent(id)}/idea`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hypothesis }),
      }).then((r) => r.ok, () => false);
      if (!saved) {
        setMadeId(id);
        setStatus("idle");
        return;
      }
    }
    router.push(`/admin/launches/${id}`);
    router.refresh();
  }

  const busy = status === "creating";

  return (
    <form onSubmit={submit} className="space-y-5">
      <Field label="Launch name" hint="Shown on the hosted waitlist page.">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Developer API Launch"
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
          <p>{IDEA_MESSAGES.hypothesisNotSaved}</p>
          <Link
            href={`/admin/launches/${madeId}`}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            Open its Overview
          </Link>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            {busy ? "Creating…" : "Create launch"}
          </button>
          <span className="text-xs text-neutral-400">
            You can fine-tune everything else in the launch&apos;s Settings tab.
          </span>
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
