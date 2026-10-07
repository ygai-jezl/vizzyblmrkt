"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { api, errorText } from "../connect/api";
import { Banner, Button, Field, Section, inputClass } from "../connect/ui";

/**
 * Rebuild the draft from a template with fresh, on-brand copy — the same
 * architect Vizzy uses from the chat. Replaces the DRAFT only. A journey that
 * continues from another (`after`) is rebuilt as the sequence that follows it:
 * a number of emails a few days apart, counted from that journey's end and sent
 * in its window; any other journey as the 7-day onboarding shape.
 */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function GeneratePanel({
  journeyId,
  after = null,
  onDone,
  onCancel,
}: {
  journeyId: string;
  /** The journey this one continues from (journey links), as saved. */
  after?: { name: string; timeline: { text: string } | null } | null;
  onDone: (notes: string[]) => void;
  onCancel: () => void;
}) {
  const [brief, setBrief] = useState("");
  const [days, setDays] = useState(7);
  const [reminders, setReminders] = useState(3);
  const [education, setEducation] = useState(3);
  const [sendDays, setSendDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [sendTime, setSendTime] = useState("09:00");
  const [emails, setEmails] = useState(4);
  const [gapDays, setGapDays] = useState(3);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    if (!window.confirm("Replace the current draft with a freshly generated one? The published version isn't affected.")) return;
    setBusy(true);
    setErr(null);
    const r = await api<{ notes: string[] }>(`/api/admin/lifecycle/journeys/${journeyId}/generate`, {
      method: "POST",
      // A follow-on keeps the send window of the journey before it.
      body: JSON.stringify({ brief, options: after ? { emails, gapDays } : { days, reminders, education, sendDays, sendTime } }),
    });
    setBusy(false);
    if (!r.ok) return setErr(errorText(r.data));
    onDone(r.data.notes ?? []);
  };

  if (after) {
    return (
      <Section
        title="Generate with AI"
        description={`Builds the sequence that follows ${after.name} and writes every email in your brand voice, knowing what people have already been sent. Numbers about each person only ever come from your product.`}
      >
        <Field label="What should these emails feel like?" hint="Optional — tone, what to emphasise, anything to avoid.">
          <textarea className={`${inputClass} min-h-16`} value={brief} onChange={(e) => setBrief(e.target.value.slice(0, 2000))} placeholder="Short, useful notes. One idea per email, nothing they heard in onboarding." />
        </Field>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Emails">
            <select className={inputClass} value={emails} onChange={(e) => setEmails(Number(e.target.value))}>
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Days between emails">
            <select className={inputClass} value={gapDays} onChange={(e) => setGapDays(Number(e.target.value))}>
              {[1, 2, 3, 4, 5, 7, 10, 14].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <p className="text-xs text-neutral-500">
          The first email goes {gapDays === 1 ? "the day" : `${gapDays} days`} after someone finishes {after.name}
          {after.timeline ? `, which sends ${after.timeline.text}` : ""}. It sends on that journey&rsquo;s days and at its time.
        </p>
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
