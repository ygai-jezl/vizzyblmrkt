"use client";

import { useState } from "react";
import type { ConnectionCatalog } from "@/lib/types/productConnection";
import { api, errorText } from "../connect/api";
import { Badge, Banner, Button, Field, Section, inputClass } from "../connect/ui";

/**
 * Dry-run the saved DRAFT for an imagined person: pick their timezone, when
 * they sign up and when (if ever) they finish each onboarding step, and see
 * exactly when each email would go out — the runner's own decision code.
 */

interface PlannedStep {
  atMs: number;
  at: string;
  day: number;
  kind: "send" | "skip" | "exit" | "complete";
  label: string;
}

function localInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function TimelinePreview({
  journeyId,
  catalog,
  defaultTimezone,
  dirty,
}: {
  journeyId: string;
  catalog: ConnectionCatalog | undefined;
  defaultTimezone: string;
  dirty: boolean;
}) {
  const steps = [...(catalog?.onboardingSteps ?? [])].sort((a, b) => a.order - b.order);
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [signup, setSignup] = useState(localInputValue(Date.now()));
  const [done, setDone] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ timezone: string; steps: PlannedStep[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setErr(null);
    const stepsDoneAfterHours = Object.fromEntries(
      Object.entries(done)
        .filter(([, v]) => v.trim() !== "")
        .map(([k, v]) => [k, Math.max(0, Number(v) || 0)]),
    );
    const r = await api<{ timezone: string; steps: PlannedStep[] }>(`/api/admin/lifecycle/journeys/${journeyId}/preview`, {
      method: "POST",
      body: JSON.stringify({ timezone, anchorAt: new Date(signup).toISOString(), stepsDoneAfterHours }),
    });
    if (!r.ok) return setErr(errorText(r.data));
    setResult(r.data);
  };

  const fmt = (iso: string, tz: string) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

  return (
    <div className="space-y-4">
      <Section title="Imagine someone who…" description="Uses the saved draft. Assumes they can receive marketing email (consent is checked for real at send time).">
        {dirty ? <Banner tone="info">You have unsaved changes — save the draft to preview them.</Banner> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Signs up at (your local time)">
            <input className={inputClass} type="datetime-local" value={signup} onChange={(e) => setSignup(e.target.value)} />
          </Field>
          <Field label="Lives in timezone">
            <input className={inputClass} value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Europe/London" />
          </Field>
        </div>
        {steps.length ? (
          <div className="space-y-2">
            <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Finishes each step this many hours after signing up (blank = never)</span>
            <div className="grid gap-2 sm:grid-cols-3">
              {steps.map((s) => (
                <Field key={s.id} label={s.label}>
                  <input className={inputClass} type="number" min={0} value={done[s.id] ?? ""} onChange={(e) => setDone({ ...done, [s.id]: e.target.value })} />
                </Field>
              ))}
            </div>
          </div>
        ) : null}
        <Button tone="primary" onClick={() => void run()}>
          Show the timeline
        </Button>
        {err ? <Banner tone="err">{err}</Banner> : null}
      </Section>

      {result ? (
        <ol className="space-y-2">
          {result.steps.map((s, i) => (
            <li key={i} className="flex flex-wrap items-center gap-3 rounded-md border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-800">
              <span className="w-14 text-xs text-neutral-500">Day {s.day}</span>
              <span className="w-40 text-xs">{fmt(s.at, result.timezone)}</span>
              <Badge tone={s.kind === "send" ? "green" : s.kind === "skip" ? "amber" : "neutral"}>{s.kind}</Badge>
              <span>{s.label}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
