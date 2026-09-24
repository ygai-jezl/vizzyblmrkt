"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Send } from "lucide-react";
import type { Funnel } from "@/lib/invites/funnel";
import type { InviteWave } from "@/lib/types/invite";
import { INVITE_LOCK_TEXT, type InviteLockReason } from "@/lib/invites/lockText";
import { api, errorText, timeAgo } from "../connect/api";
import { Badge, Banner, Button, Field, Section, inputClass } from "../connect/ui";
import { LaunchFunnel } from "./LaunchFunnel";

/**
 * A launch's Invites page (nav v2 phase 4): the funnel, the waves sent so far,
 * and a composer for the next wave. Drafts can come from a person or Vizzy;
 * only an admin sends. Sending takes each person off the waitlist as their
 * invite goes out.
 */

export interface WaveProgress {
  queued: number;
  invited: number;
  signedUp: number;
  activated: number;
  skipped: number;
  failed: number;
}

export interface LaunchInvitesView {
  lock: InviteLockReason | null;
  lockText: string | null;
  connections: Array<{ id: string; name: string; productName: string; signupUrl: string | null }>;
  funnel: Funnel;
  /** Verified people still on the waitlist. */
  waiting: number;
  waves: Array<InviteWave & { progress: WaveProgress | null }>;
  defaults: {
    subject: string;
    body: string;
    expiresInDays: number;
    maxSize: number;
    minExpiryDays: number;
    maxExpiryDays: number;
  };
  tags: string[];
}

interface Draft {
  id: string | null;
  connectionId: string;
  size: number;
  excludeExistingUsers: boolean;
  expiresInDays: number;
  subject: string;
  body: string;
}

interface Preview {
  selected: number;
  alreadyInvited: number;
  noEmail: number;
  existingUsers: number;
  sample: { subject: string; html: string } | null;
}

const STATUS_TONE: Record<InviteWave["status"], "neutral" | "green" | "amber" | "red"> = {
  draft: "neutral",
  sending: "amber",
  sent: "green",
  cancelled: "red",
};

function draftFrom(view: LaunchInvitesView, wave?: InviteWave): Draft {
  if (wave) {
    return {
      id: wave.id,
      connectionId: wave.connectionId,
      size: wave.size,
      excludeExistingUsers: wave.excludeExistingUsers,
      expiresInDays: wave.expiresInDays,
      subject: wave.subject,
      body: wave.body,
    };
  }
  return {
    id: null,
    connectionId: view.connections[0]?.id ?? "",
    size: Math.min(Math.max(view.waiting, 1), 100, view.defaults.maxSize),
    excludeExistingUsers: true,
    expiresInDays: view.defaults.expiresInDays,
    subject: view.defaults.subject,
    body: view.defaults.body,
  };
}

export function InvitesClient({
  campaignId,
  initial,
  canSend,
  myEmail,
  initialWaveId,
}: {
  campaignId: string;
  initial: LaunchInvitesView;
  canSend: boolean;
  myEmail: string | null;
  initialWaveId?: string | null;
}) {
  const [view, setView] = useState(initial);
  const openWave = initialWaveId ? initial.waves.find((w) => w.id === initialWaveId && w.status === "draft") : undefined;
  const [draft, setDraft] = useState<Draft | null>(openWave ? draftFrom(initial, openWave) : null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const base = `/api/admin/campaigns/${encodeURIComponent(campaignId)}/invites`;

  const reload = useCallback(async () => {
    const r = await api<LaunchInvitesView>(base);
    if (r.ok) setView(r.data);
  }, [base]);

  // A draft the composer is showing may change under it (e.g. Vizzy saved a new version).
  useEffect(() => setPreview(null), [draft?.id]);

  const fail = (data: unknown) => {
    const d = (data ?? {}) as { error?: string; detail?: string };
    const lock = d.error === "invites_locked" && d.detail ? INVITE_LOCK_TEXT[d.detail as InviteLockReason] : null;
    setMessage({ tone: "err", text: lock ?? errorText(data) });
  };

  /** Save the draft (create or update) and return its id. */
  async function save(): Promise<string | null> {
    if (!draft) return null;
    const body = {
      connectionId: draft.connectionId || undefined,
      size: draft.size,
      excludeExistingUsers: draft.excludeExistingUsers,
      expiresInDays: draft.expiresInDays,
      subject: draft.subject,
      body: draft.body,
    };
    const r = draft.id
      ? await api<{ wave: InviteWave }>(`${base}/waves/${draft.id}`, { method: "PATCH", body: JSON.stringify(body) })
      : await api<{ wave: InviteWave }>(`${base}/waves`, { method: "POST", body: JSON.stringify(body) });
    if (!r.ok) {
      fail(r.data);
      return null;
    }
    setDraft(draftFrom(view, r.data.wave));
    return r.data.wave.id;
  }

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setMessage(null);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  const onSave = () =>
    run("save", async () => {
      if (await save()) {
        setMessage({ tone: "ok", text: "Draft saved. Nothing has been sent." });
        await reload();
      }
    });

  const onPreview = () =>
    run("preview", async () => {
      const id = await save();
      if (!id) return;
      const r = await api<Preview>(`${base}/waves/${id}/preview`, { method: "POST" });
      if (r.ok) setPreview(r.data);
      else fail(r.data);
    });

  const onTest = () =>
    run("test", async () => {
      const id = await save();
      if (!id) return;
      const r = await api<{ to: string }>(`${base}/waves/${id}/test`, { method: "POST" });
      if (r.ok) setMessage({ tone: "ok", text: `Test sent to ${r.data.to}. Its button goes straight to your sign-up page.` });
      else fail(r.data);
    });

  const onSend = () =>
    run("send", async () => {
      const id = await save();
      if (!id) return;
      const p = await api<Preview>(`${base}/waves/${id}/preview`, { method: "POST" });
      if (!p.ok) return fail(p.data);
      if (p.data.selected === 0) {
        setMessage({ tone: "err", text: "Nobody left to invite: everyone verified has been invited or already uses the product." });
        return;
      }
      const ok = window.confirm(
        `Invite ${p.data.selected.toLocaleString("en-GB")} ${p.data.selected === 1 ? "person" : "people"} now? ` +
          "Each one leaves the waitlist as their invite is sent. This can't be undone.",
      );
      if (!ok) return;
      const r = await api<{ wave: InviteWave }>(`${base}/waves/${id}/send`, { method: "POST" });
      if (!r.ok) return fail(r.data);
      setDraft(null);
      setMessage({
        tone: "ok",
        text: `${r.data.wave.counts.created.toLocaleString("en-GB")} invites are on their way.`,
      });
      await reload();
    });

  const onDelete = (id: string) =>
    run("delete", async () => {
      const r = await api(`${base}/waves/${id}`, { method: "DELETE" });
      if (!r.ok) return fail(r.data);
      if (draft?.id === id) setDraft(null);
      await reload();
    });

  const onCancel = (id: string) =>
    run("cancel", async () => {
      if (!window.confirm("Cancel this wave? Invites that haven't gone out yet won't be sent.")) return;
      const r = await api(`${base}/waves/${id}/cancel`, { method: "POST" });
      if (!r.ok) return fail(r.data);
      await reload();
    });

  const product = useMemo(
    () => view.connections.find((c) => c.id === draft?.connectionId) ?? view.connections[0] ?? null,
    [view.connections, draft?.connectionId],
  );

  return (
    <div className="space-y-6">
      <LaunchFunnel funnel={view.funnel} caption="Signed up and activated come from your product's events, matched to each invite." />

      {view.lock ? (
        <Banner tone="info">
          {view.lockText}{" "}
          <Link href="/admin/products" className="underline">
            Go to Products
          </Link>
        </Banner>
      ) : null}
      {message ? <Banner tone={message.tone}>{message.text}</Banner> : null}

      <Section
        title="Invite waves"
        description={`${view.waiting.toLocaleString("en-GB")} verified ${view.waiting === 1 ? "person is" : "people are"} still on the waitlist. Each wave invites people from the top of the ranking.`}
        actions={
          !view.lock && canSend && !draft ? (
            <Button tone="primary" onClick={() => setDraft(draftFrom(view))}>
              <Send className="h-3.5 w-3.5" aria-hidden /> New invite wave
            </Button>
          ) : null
        }
      >
        {view.waves.length === 0 ? (
          <p className="text-sm text-neutral-500">No invites yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {view.waves.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {w.name}
                    <Badge tone={STATUS_TONE[w.status]}>{w.status}</Badge>
                    {w.authoredBy === "agent" && w.status === "draft" ? <Badge>Drafted by Vizzy</Badge> : null}
                  </p>
                  <p className="text-xs text-neutral-500">
                    {w.status === "draft"
                      ? `Up to ${w.size.toLocaleString("en-GB")} people · saved ${timeAgo(w.updatedAt)}`
                      : w.progress
                        ? [
                            `${w.progress.invited} invited`,
                            `${w.progress.signedUp} signed up`,
                            `${w.progress.activated} activated`,
                            w.progress.queued ? `${w.progress.queued} sending` : null,
                            w.progress.skipped ? `${w.progress.skipped} skipped` : null,
                            w.progress.failed ? `${w.progress.failed} failed` : null,
                          ]
                            .filter(Boolean)
                            .join(" · ") + ` · sent ${timeAgo(w.sentAt)}`
                        : ""}
                  </p>
                </div>
                {canSend ? (
                  <div className="flex gap-2">
                    {w.status === "draft" ? (
                      <>
                        <Button onClick={() => setDraft(draftFrom(view, w))} disabled={!!busy}>
                          Open
                        </Button>
                        <Button tone="danger" onClick={() => onDelete(w.id)} disabled={!!busy}>
                          Delete
                        </Button>
                      </>
                    ) : w.status !== "cancelled" && (w.progress?.queued ?? 0) > 0 ? (
                      <Button tone="danger" onClick={() => onCancel(w.id)} disabled={!!busy}>
                        Cancel unsent
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {draft ? (
        <Section
          title={draft.id ? "Edit invite wave" : "New invite wave"}
          description="Nothing is sent until you press Send invites."
          actions={
            <Button onClick={() => setDraft(null)} disabled={!!busy}>
              Close
            </Button>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Product" hint={product?.signupUrl ? `People land on ${product.signupUrl}` : undefined}>
              <select
                className={inputClass}
                value={draft.connectionId}
                onChange={(e) => setDraft({ ...draft, connectionId: e.target.value })}
              >
                {view.connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.productName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="How many people" hint={`From the top of the waitlist (at most ${view.defaults.maxSize.toLocaleString("en-GB")} per wave).`}>
              <input
                type="number"
                className={inputClass}
                min={1}
                max={view.defaults.maxSize}
                value={draft.size}
                onChange={(e) => setDraft({ ...draft, size: Math.max(1, Math.min(view.defaults.maxSize, Number(e.target.value) || 1)) })}
              />
            </Field>
            <Field label="Invite links work for (days)">
              <input
                type="number"
                className={inputClass}
                min={view.defaults.minExpiryDays}
                max={view.defaults.maxExpiryDays}
                value={draft.expiresInDays}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    expiresInDays: Math.max(
                      view.defaults.minExpiryDays,
                      Math.min(view.defaults.maxExpiryDays, Number(e.target.value) || view.defaults.expiresInDays),
                    ),
                  })
                }
              />
            </Field>
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input
                type="checkbox"
                checked={draft.excludeExistingUsers}
                onChange={(e) => setDraft({ ...draft, excludeExistingUsers: e.target.checked })}
              />
              Skip people who already use the product
            </label>
          </div>
          <Field label="Subject">
            <input className={inputClass} value={draft.subject} maxLength={200} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
          </Field>
          <Field
            label="Email"
            hint={`Tags you can use: ${["{{first_name}}", "{{waitlist_name}}", ...view.tags.map((t) => `{{${t}}}`)].join(" ")}. {{invite_link}} becomes the button.`}
          >
            <textarea
              className={`${inputClass} min-h-[12rem] font-mono text-xs`}
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button onClick={onSave} disabled={!!busy}>
              {busy === "save" ? "Saving…" : "Save draft"}
            </Button>
            <Button onClick={onPreview} disabled={!!busy}>
              {busy === "preview" ? "Checking…" : "Preview"}
            </Button>
            {myEmail ? (
              <Button onClick={onTest} disabled={!!busy}>
                {busy === "test" ? "Sending…" : "Send a test to me"}
              </Button>
            ) : null}
            {canSend ? (
              <Button tone="primary" onClick={onSend} disabled={!!busy || !!view.lock}>
                <Send className="h-3.5 w-3.5" aria-hidden /> {busy === "send" ? "Sending…" : "Send invites"}
              </Button>
            ) : null}
          </div>
          {preview ? (
            <div className="space-y-2 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
              <p className="text-sm">
                This wave would invite <strong>{preview.selected.toLocaleString("en-GB")}</strong>{" "}
                {preview.selected === 1 ? "person" : "people"}.
                {preview.alreadyInvited ? ` ${preview.alreadyInvited} already invited.` : ""}
                {preview.existingUsers ? ` ${preview.existingUsers} already use the product.` : ""}
                {preview.noEmail ? ` ${preview.noEmail} have no email address.` : ""}
              </p>
              {preview.sample ? (
                <>
                  <p className="text-xs text-neutral-500">Subject: {preview.sample.subject}</p>
                  <iframe
                    title="Invite email preview"
                    sandbox=""
                    srcDoc={preview.sample.html}
                    className="h-96 w-full rounded border border-neutral-200 bg-white dark:border-neutral-800"
                  />
                </>
              ) : null}
            </div>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}
