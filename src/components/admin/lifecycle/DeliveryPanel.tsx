"use client";

import { useState } from "react";
import Link from "next/link";
import type { DeliveryMode, LifecycleJourney } from "@/lib/types/lifecycle";
import { api, errorText } from "../connect/api";
import { Badge, Banner, Button, Field, Section, inputClass } from "../connect/ui";
import type { JourneyDetail } from "./model";

/**
 * Who actually gets the emails: test (listed test users only), shadow (real
 * users progress, mail goes to your shadow inbox) or live. Plus daily caps.
 */

const MODES: Array<{ id: DeliveryMode; title: string; body: string }> = [
  { id: "test", title: "Test", body: "Only the test users below are enrolled, and they get real emails." },
  {
    id: "shadow",
    title: "Shadow",
    body: "Everyone is enrolled and moves through the journey, but every email goes to your shadow inbox instead — with a banner naming who it was for.",
  },
  { id: "live", title: "Live", body: "Real emails to real users. Needs a verified sending domain." },
];

const RANK: Record<DeliveryMode, number> = { test: 0, shadow: 1, live: 2 };

const splitList = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

export function DeliveryPanel({
  detail,
  canEdit,
  onSaved,
}: {
  detail: JourneyDetail;
  canEdit: boolean;
  onSaved: (journey: LifecycleJourney) => void;
}) {
  const j = detail.journey;
  const [mode, setMode] = useState<DeliveryMode>(j.deliveryMode);
  const [userIds, setUserIds] = useState(j.testRecipients.userIds.join("\n"));
  const [emails, setEmails] = useState(j.testRecipients.emails.join("\n"));
  const [shadowInbox, setShadowInbox] = useState(j.shadowInbox ?? "");
  const [sendsPerDay, setSendsPerDay] = useState(j.caps.sendsPerDay);
  const [enrolmentsPerDay, setEnrolmentsPerDay] = useState(j.caps.enrolmentsPerDay);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    const r = await api<{ journey: LifecycleJourney }>(`/api/admin/lifecycle/journeys/${j.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        deliveryMode: mode,
        testRecipients: { userIds: splitList(userIds).slice(0, 50), emails: splitList(emails).slice(0, 50) },
        shadowInbox: shadowInbox.trim() || null,
        caps: { sendsPerDay, enrolmentsPerDay },
      }),
    });
    setBusy(false);
    if (!r.ok) return setMsg({ tone: "err", text: errorText(r.data) });
    setMsg({ tone: "ok", text: "Saved." });
    onSaved(r.data.journey);
  };

  const sandboxIds = detail.connection?.sandboxUsers ?? [];
  const capped = RANK[mode] > RANK[detail.modeCeiling];

  return (
    <div className="space-y-4">
      <Section title="Delivery mode" description="Existing enrolments keep the mode they started in, so switching to live never surprises someone mid-sequence.">
        <div className="grid gap-2 sm:grid-cols-3">
          {MODES.map((m) => (
            <label
              key={m.id}
              className={`cursor-pointer space-y-1 rounded-lg border p-3 ${
                mode === m.id ? "border-neutral-900 dark:border-white" : "border-neutral-200 dark:border-neutral-800"
              }`}
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <input type="radio" name="mode" disabled={!canEdit} checked={mode === m.id} onChange={() => setMode(m.id)} />
                {m.title}
              </span>
              <span className="block text-xs text-neutral-500">{m.body}</span>
            </label>
          ))}
        </div>
        {capped ? (
          <Banner tone="info">
            This environment only allows up to <b>{detail.modeCeiling}</b> — sends beyond that are held until it&rsquo;s raised.
          </Banner>
        ) : null}
        {mode === "live" && !detail.sender.verified ? (
          <Banner tone="err">
            Live needs the From address on a verified sending domain. Set one in{" "}
            <Link className="underline" href="/admin/account">
              Account → Domains
            </Link>{" "}
            or on the Settings tab.
          </Banner>
        ) : null}
        {mode === "live" && !detail.postalAddress ? (
          <Banner tone="err">
            Add your postal address in{" "}
            <Link className="underline" href="/admin/account">
              Account → Domains
            </Link>{" "}
            — marketing emails are held without one.
          </Banner>
        ) : null}
      </Section>

      <Section title="Test users" description="Enrolled (and emailed) in test mode. Use the product's own user ids, or their email addresses.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="User ids" hint={sandboxIds.length ? `Sandbox users: ${sandboxIds.map((u) => u.userId).join(", ")}` : "One per line."}>
            <textarea className={`${inputClass} min-h-20 font-mono text-xs`} disabled={!canEdit} value={userIds} onChange={(e) => setUserIds(e.target.value)} />
          </Field>
          <Field label="Email addresses" hint="One per line.">
            <textarea className={`${inputClass} min-h-20 font-mono text-xs`} disabled={!canEdit} value={emails} onChange={(e) => setEmails(e.target.value)} />
          </Field>
        </div>
      </Section>

      <Section title="Shadow inbox" description="Your own address or one on a verified sending domain — shadow emails name the real recipient.">
        <input className={inputClass} type="email" disabled={!canEdit} value={shadowInbox} onChange={(e) => setShadowInbox(e.target.value)} placeholder="you@yourcompany.com" />
      </Section>

      <Section title="Daily caps" description="Exact limits per journey, per UTC day. Over the cap, sends wait for the next day's window.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Emails per day">
            <input className={inputClass} type="number" min={1} max={10000} disabled={!canEdit} value={sendsPerDay} onChange={(e) => setSendsPerDay(Math.min(10000, Math.max(1, Number(e.target.value) || 1)))} />
          </Field>
          <Field label="New enrolments per day">
            <input className={inputClass} type="number" min={1} max={10000} disabled={!canEdit} value={enrolmentsPerDay} onChange={(e) => setEnrolmentsPerDay(Math.min(10000, Math.max(1, Number(e.target.value) || 1)))} />
          </Field>
        </div>
      </Section>

      {canEdit ? (
        <div className="flex items-center gap-3">
          <Button tone="primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save delivery settings"}
          </Button>
          <Badge tone={j.deliveryMode === "live" ? "green" : "amber"}>now: {j.deliveryMode}</Badge>
        </div>
      ) : null}
      {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}
    </div>
  );
}
