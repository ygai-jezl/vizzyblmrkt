"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { api, errorText } from "../connect/api";
import { Banner, Button, Field, Section, inputClass } from "../connect/ui";

/**
 * Rebuild the draft from the onboarding template with fresh, on-brand copy —
 * the same architect Vizzy uses from the chat. Replaces the DRAFT only.
 */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function GeneratePanel({
  journeyId,
  onDone,
  onCancel,
}: {
  journeyId: string;
  onDone: (notes: string[]) => void;
  onCancel: () => void;
}) {
  const [brief, setBrief] = useState("");
  const [days, setDays] = useState(7);
  const [reminders, setReminders] = useState(3);
  const [education, setEducation] = useState(3);
  const [sendDays, setSendDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [sendTime, setSendTime] = useState("09:00");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    if (!window.confirm("Replace the current draft with a freshly generated one? The published version isn't affected.")) return;
    setBusy(true);
    setErr(null);
    const r = await api<{ notes: string[] }>(`/api/admin/lifecycle/journeys/${journeyId}/generate`, {
      method: "POST",
      body: JSON.stringify({ brief, options: { days, reminders, education, sendDays, sendTime } }),
    });
    setBusy(false);
    if (!r.ok) return setErr(errorText(r.data));
    onDone(r.data.notes ?? []);
  };

  return (
    <Section
      title="Generate with AI"
      description="Builds the 7-day onboarding shape from your product's catalog and writes every email in your brand voice. Numbers about each person only ever come from your product."
    >
      <Field label="What should these emails feel like?" hint="Optional — tone, what to emphasise, anything to avoid.">
        <textarea className={`${inputClass} min-h-16`} value={brief} onChange={(e) => setBrief(e.target.value.slice(0, 2000))} placeholder="Short, warm notes from the founder. Focus on getting the first audit run." />
      </Field>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Length">
          <select className={inputClass} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[5, 7, 10, 14].map((d) => (
              <option key={d} value={d}>
                about {d} days
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reminder emails">
          <select className={inputClass} value={reminders} onChange={(e) => setReminders(Number(e.target.value))}>
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Education emails">
          <select className={inputClass} value={education} onChange={(e) => setEducation(Number(e.target.value))}>
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Send from">
          <input className={inputClass} type="time" value={sendTime} onChange={(e) => setSendTime(e.target.value)} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {DAYS.map((d, i) => (
          <label key={d} className="flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-sm dark:border-neutral-800">
            <input
              type="checkbox"
              checked={sendDays.includes(i)}
              onChange={(e) => {
                const next = e.target.checked ? [...sendDays, i].sort() : sendDays.filter((x) => x !== i);
                if (next.length) setSendDays(next);
              }}
            />
            {d}
          </label>
        ))}
      </div>
      {err ? <Banner tone="err">{err}</Banner> : null}
      <div className="flex gap-2">
        <Button tone="primary" disabled={busy} onClick={() => void run()}>
          <Sparkles size={14} /> {busy ? "Writing… (about a minute)" : "Generate draft"}
        </Button>
        <Button disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Section>
  );
}
