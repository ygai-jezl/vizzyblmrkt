"use client";

import { useState } from "react";
import { Plus, Send } from "lucide-react";
import { api, errorText, timeAgo, type PublicConnection, type SandboxUser } from "./api";
import { Banner, Button, Field, JsonBlock, Section, inputClass } from "./ui";

type Action =
  | { kind: "signed_up" }
  | { kind: "identify" }
  | { kind: "step"; step: string }
  | { kind: "completed" }
  | { kind: "preferences"; category: string; subscribed: boolean }
  | { kind: "deleted" };

/**
 * The sandbox acting as your product: edit its test users, fire the events a
 * real product would send (through the real, signed ingest path), and see the
 * webhooks the platform sends back.
 */
export function SandboxPanel({
  connection,
  canEdit,
  onChanged,
}: {
  connection: PublicConnection;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [users, setUsers] = useState<SandboxUser[]>(connection.sandbox?.users ?? []);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<unknown>(null);
  const steps = [...connection.catalog.onboardingSteps].sort((a, b) => a.order - b.order);

  async function saveUsers(next: SandboxUser[]) {
    setBusy("save");
    setMsg(null);
    const r = await api<{ users: SandboxUser[] }>(`/api/admin/connections/${connection.id}/sandbox/users`, {
      method: "PUT",
      body: JSON.stringify({ users: next }),
    });
    setBusy(null);
    if (!r.ok) return setMsg({ tone: "err", text: errorText(r.data) });
    setUsers(r.data.users);
    setMsg({ tone: "ok", text: "Test users saved." });
    onChanged();
  }

  async function fire(userId: string, action: Action, label: string) {
    setBusy(`${userId}:${label}`);
    setMsg(null);
    const r = await api(`/api/admin/connections/${connection.id}/sandbox/fire`, {
      method: "POST",
      body: JSON.stringify({ userId, action }),
    });
    setBusy(null);
    setLastResult(r.data);
    if (!r.ok) return setMsg({ tone: "err", text: errorText(r.data) });
    setMsg({ tone: "ok", text: `Sent “${label}” for ${userId}.` });
    onChanged();
  }

  async function testWebhook() {
    setBusy("webhook");
    const r = await api<{ ok: boolean; error?: string }>(`/api/admin/connections/${connection.id}/test-webhook`, {
      method: "POST",
    });
    setBusy(null);
    setMsg(r.ok && r.data.ok ? { tone: "ok", text: "Test webhook delivered." } : { tone: "err", text: errorText(r.data) });
    onChanged();
  }

  function patchUser(i: number, patch: Partial<SandboxUser>) {
    setUsers((cur) => cur.map((u, j) => (j === i ? { ...u, ...patch } : u)));
  }

  return (
    <div className="space-y-4">
      {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}

      <Section
        title="Test users"
        description="The sandbox's context endpoint serves these users' steps, facts and insights. Addresses must be yours or on a verified sending domain."
        actions={
          canEdit ? (
            <Button
              disabled={users.length >= 10}
              onClick={() =>
                setUsers((cur) => [
                  ...cur,
                  { ...(cur[0] ?? { email: "", timezone: "Europe/London", steps: {}, facts: [], insights: [] }), userId: `sandbox_user_${cur.length + 1}`, firstName: null, steps: {} } as SandboxUser,
                ])
              }
            >
              <Plus size={14} /> Add test user
            </Button>
          ) : null
        }
      >
        {users.map((u, i) => (
          <div key={i} className="space-y-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
            <div className="grid gap-2 sm:grid-cols-3">
              <Field label="User id">
                <input className={`${inputClass} font-mono`} disabled={!canEdit} value={u.userId} onChange={(e) => patchUser(i, { userId: e.target.value })} />
              </Field>
              <Field label="Email">
                <input className={inputClass} disabled={!canEdit} value={u.email} onChange={(e) => patchUser(i, { email: e.target.value })} />
              </Field>
              <Field label="First name">
                <input className={inputClass} disabled={!canEdit} value={u.firstName ?? ""} onChange={(e) => patchUser(i, { firstName: e.target.value || null })} />
              </Field>
            </div>
            <div className="text-sm">
              <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Onboarding (what the context endpoint reports)</span>
              <div className="mt-1 flex flex-wrap gap-3">
                {steps.map((s) => (
                  <label key={s.id} className="flex items-center gap-1.5">
                    <input type="checkbox" disabled={!canEdit} checked={u.steps[s.id] === true}
                      onChange={(e) => patchUser(i, { steps: { ...u.steps, [s.id]: e.target.checked } })} />
                    {s.label}
                  </label>
                ))}
              </div>
            </div>
            <details>
              <summary className="cursor-pointer text-xs text-neutral-500">
                Facts ({u.facts.length}) and insights ({u.insights.length})
              </summary>
              <JsonBlock value={{ facts: u.facts, insights: u.insights }} />
            </details>
            {canEdit ? (
              <div className="flex flex-wrap gap-2 border-t border-neutral-100 pt-3 dark:border-neutral-900">
                <span className="self-center text-xs text-neutral-500">Send as the product:</span>
                <Button disabled={busy !== null} onClick={() => void fire(u.userId, { kind: "signed_up" }, "signed up")}>
                  <Send size={13} /> Signed up
                </Button>
                {steps.map((s) => (
                  <Button key={s.id} disabled={busy !== null} onClick={() => void fire(u.userId, { kind: "step", step: s.id }, s.label)}>
                    ✓ {s.label}
                  </Button>
                ))}
                <Button disabled={busy !== null} onClick={() => void fire(u.userId, { kind: "completed" }, "onboarding completed")}>
                  Onboarding completed
                </Button>
                <Button disabled={busy !== null}
                  onClick={() => void fire(u.userId, { kind: "preferences", category: "onboarding", subscribed: false }, "unsubscribed from onboarding tips")}>
                  Unsubscribe tips
                </Button>
                <Button tone="danger" disabled={busy !== null} onClick={() => void fire(u.userId, { kind: "deleted" }, "user deleted")}>
                  Delete user
                </Button>
              </div>
            ) : null}
          </div>
        ))}
        {canEdit ? (
          <div className="flex justify-end">
            <Button tone="primary" disabled={busy !== null} onClick={() => void saveUsers(users)}>
              {busy === "save" ? "Saving…" : "Save test users"}
            </Button>
          </div>
        ) : null}
      </Section>

      {lastResult ? (
        <Section title="Last ingest response">
          <JsonBlock value={lastResult} />
        </Section>
      ) : null}

      <Section
        title="Webhook inbox"
        description="Signed webhooks the platform sent to the sandbox (e.g. unsubscribes), verified like a real product would."
        actions={canEdit ? <Button disabled={busy !== null} onClick={() => void testWebhook()}>Send test webhook</Button> : null}
      >
        {connection.sandbox?.webhookInbox.length ? (
          <ul className="space-y-1 text-xs">
            {connection.sandbox.webhookInbox.map((w, i) => (
              <li key={i} className="truncate font-mono">
                <span className="text-neutral-400">{timeAgo(w.receivedAt)}</span> {w.type} — {w.body}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-neutral-500">Nothing received yet.</p>
        )}
      </Section>
    </div>
  );
}
