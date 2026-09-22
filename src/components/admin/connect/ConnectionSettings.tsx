"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/admin/email/Modal";
import { api, errorText, type PublicConnection } from "./api";
import { KeyReveal } from "./KeyReveal";
import { Banner, Button, Field, Section, inputClass } from "./ui";

const BASES = ["consent", "soft_opt_in", "corporate_subscriber"] as const;

/** Name, status, endpoints, link domains, consent policy; rotate and revoke. */
export function ConnectionSettings({
  connection,
  canEdit,
  onSaved,
}: {
  connection: PublicConnection;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const router = useRouter();
  const sandbox = connection.kind === "sandbox";
  const [name, setName] = useState(connection.name);
  const [ctxUrl, setCtxUrl] = useState(connection.contextEndpoint?.url ?? "");
  const [ctxOn, setCtxOn] = useState(connection.contextEndpoint?.enabled ?? false);
  const [timeoutMs, setTimeoutMs] = useState(connection.contextEndpoint?.timeoutMs ?? 5000);
  const [hookUrl, setHookUrl] = useState(connection.webhookEndpoint?.url ?? "");
  const [hookOn, setHookOn] = useState(connection.webhookEndpoint?.enabled ?? false);
  const [domains, setDomains] = useState(connection.linkDomains.join(", "));
  const [verifyCorp, setVerifyCorp] = useState(connection.consentPolicy.verifyCorporateDomain);
  const [bases, setBases] = useState<string[]>(connection.consentPolicy.marketingBases);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const disabled = !canEdit || connection.status === "revoked";

  async function patch(body: Record<string, unknown>, okText: string) {
    setBusy(true);
    setMsg(null);
    const r = await api(`/api/admin/connections/${connection.id}`, { method: "PATCH", body: JSON.stringify(body) });
    setBusy(false);
    if (!r.ok) return setMsg({ tone: "err", text: errorText(r.data) });
    setMsg({ tone: "ok", text: okText });
    onSaved();
  }

  function save() {
    const body: Record<string, unknown> = {
      name,
      linkDomains: domains.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean),
      consentPolicy: { verifyCorporateDomain: verifyCorp, marketingBases: bases },
    };
    if (!sandbox) {
      body.contextEndpoint = ctxUrl.trim() ? { url: ctxUrl.trim(), enabled: ctxOn, timeoutMs } : null;
      body.webhookEndpoint = hookUrl.trim() ? { url: hookUrl.trim(), enabled: hookOn } : null;
    }
    void patch(body, "Settings saved.");
  }

  async function rotate() {
    if (!window.confirm("Issue a new secret? The current one keeps working for 24 hours.")) return;
    const r = await api<{ secret: string }>(`/api/admin/connections/${connection.id}/rotate`, { method: "POST" });
    if (!r.ok) return setMsg({ tone: "err", text: errorText(r.data) });
    setNewSecret(r.data.secret);
    onSaved();
  }

  async function revoke() {
    if (!window.confirm(`Revoke “${connection.name}”? Its key stops working immediately. This can't be undone.`)) return;
    const r = await api(`/api/admin/connections/${connection.id}`, { method: "DELETE" });
    if (!r.ok) return setMsg({ tone: "err", text: errorText(r.data) });
    router.push("/admin/products");
  }

  return (
    <div className="space-y-4">
      {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}

      <Section title="General">
        <Field label="Name">
          <input className={inputClass} disabled={disabled} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="flex items-center gap-2 text-sm">
          Status: <strong>{connection.status}</strong>
          {connection.status !== "revoked" && canEdit ? (
            <Button
              disabled={busy}
              onClick={() =>
                void patch(
                  { status: connection.status === "active" ? "paused" : "active" },
                  connection.status === "active" ? "Paused — no journeys will send for this product." : "Resumed.",
                )
              }
            >
              {connection.status === "active" ? "Pause" : "Resume"}
            </Button>
          ) : null}
        </div>
      </Section>

      <Section
        title="Endpoints"
        description={sandbox ? "A sandbox's endpoints point at its built-in reference implementation." : "Requests from the platform to your product, each carrying a JWT signed with our key (verify it against /.well-known/jwks.json, audience = your key id). Public https on port 443 only; no redirects."}
      >
        <Field label="Context endpoint (POST, signed)" hint="Returns the user's onboarding steps, facts and insight sentences.">
          <input className={inputClass} disabled={disabled || sandbox} value={ctxUrl} placeholder="https://api.yourproduct.com/yougrow/context" onChange={(e) => setCtxUrl(e.target.value)} />
        </Field>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" disabled={disabled || sandbox} checked={ctxOn} onChange={(e) => setCtxOn(e.target.checked)} /> Enabled
          </label>
          <label className="flex items-center gap-1.5">
            Timeout
            <input type="number" min={500} max={5000} step={500} className={`${inputClass} w-24`} disabled={disabled || sandbox} value={timeoutMs}
              onChange={(e) => setTimeoutMs(Number(e.target.value) || 5000)} />
            ms
          </label>
        </div>
        <Field label="Webhook endpoint (POST, signed)" hint="Receives preference changes, e.g. an unsubscribe, so your product can mirror them.">
          <input className={inputClass} disabled={disabled || sandbox} value={hookUrl} placeholder="https://api.yourproduct.com/yougrow/webhook" onChange={(e) => setHookUrl(e.target.value)} />
        </Field>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" disabled={disabled || sandbox} checked={hookOn} onChange={(e) => setHookOn(e.target.checked)} /> Enabled
        </label>
        <Field label="Allowed link domains" hint="Step links your product returns must be https on one of these domains; others are dropped.">
          <input className={inputClass} disabled={disabled} value={domains} placeholder="yourproduct.com" onChange={(e) => setDomains(e.target.value)} />
        </Field>
      </Section>

      <Section title="Consent policy" description="Your product states each user's legal basis; marketing-class emails only go to these bases.">
        <div className="flex flex-wrap gap-4 text-sm">
          {BASES.map((b) => (
            <label key={b} className="flex items-center gap-1.5">
              <input type="checkbox" disabled={disabled} checked={bases.includes(b)}
                onChange={(e) => setBases((cur) => (e.target.checked ? [...cur, b] : cur.filter((x) => x !== b)))} />
              {b}
            </label>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" disabled={disabled} checked={verifyCorp} onChange={(e) => setVerifyCorp(e.target.checked)} />
          Treat corporate_subscriber on free-mail addresses (Gmail…) as no basis
        </label>
      </Section>

      {canEdit && connection.status !== "revoked" ? (
        <div className="flex justify-end">
          <Button tone="primary" disabled={busy} onClick={save}>
            {busy ? "Saving…" : "Save settings"}
          </Button>
        </div>
      ) : null}

      {canEdit && connection.status !== "revoked" ? (
        <Section title="Credentials" description={`Key id ${connection.keyId} · secret ${connection.secretPrefix}…${connection.rotating ? " · rotating (old secret still valid)" : ""}`}>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void rotate()}>Rotate secret</Button>
            <Button tone="danger" onClick={() => void revoke()}>Revoke connection</Button>
          </div>
        </Section>
      ) : null}

      <Modal open={newSecret !== null} onClose={() => setNewSecret(null)} title="New secret">
        {newSecret ? <KeyReveal keyId={connection.keyId} secret={newSecret} /> : null}
      </Modal>
    </div>
  );
}
