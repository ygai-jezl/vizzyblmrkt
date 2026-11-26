"use client";

import { useState } from "react";
import Link from "next/link";
import { HOW_THIS_WORKS, LEARNING_SETTING, learningOffLine } from "@/lib/loops/learnedWords";
import { learnedAction } from "@/components/admin/brand-kit/learnedClient";

/**
 * Settings › General › Learning (learning loops step 4, screen 5, IMAGE_STYLE_VERSIONS_ENABLED):
 * Help check that learning works, on by default. Off, no image of the brand is made without what
 * YouGrow learned, and the brand's own learning carries on. Admins change it; members read it.
 * /help/what-yougrow-learned#holdback explains it.
 */
export function LearningSettingCard({ isAdmin, offSince: initial }: { isAdmin: boolean; offSince: string | null }) {
  const [offSince, setOffSince] = useState<string | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = offSince === null;

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    const r = await learnedAction<{ offSince?: string | null }>({ op: "help_check", on: next });
    setBusy(false);
    if (!r.ok) {
      setError(r.status === 403 ? LEARNING_SETTING.member : "Couldn't save. Try again.");
      return;
    }
    setOffSince(r.data.offSince ?? null);
  }

  return (
    <section id="learning" aria-labelledby="learning-h" className="max-w-2xl scroll-mt-16 space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="learning-h" className="text-sm font-semibold">
          {LEARNING_SETTING.title}
        </h2>
        <Link href="/help/what-yougrow-learned#holdback" className="text-xs text-neutral-600 underline-offset-2 hover:underline dark:text-neutral-400">
          {HOW_THIS_WORKS}
        </Link>
      </div>
      <div className="space-y-2 rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
        <label className="flex items-start gap-3">
          <input type="checkbox" checked={on} disabled={!isAdmin || busy} onChange={(e) => void toggle(e.target.checked)} className="mt-1" />
          <span>
            <span className="block text-sm font-medium">{LEARNING_SETTING.toggle}</span>
            <span className="block text-sm text-neutral-600 dark:text-neutral-400">{LEARNING_SETTING.words}</span>
          </span>
        </label>
        {offSince ? (
          <p role="status" className="text-sm text-neutral-700 dark:text-neutral-300">
            {learningOffLine(offSince)}
          </p>
        ) : null}
        {!isAdmin ? <p className="text-xs text-neutral-600 dark:text-neutral-400">{LEARNING_SETTING.member}</p> : null}
        {error ? <p className="text-sm text-red-700 dark:text-red-300">{error}</p> : null}
      </div>
    </section>
  );
}
