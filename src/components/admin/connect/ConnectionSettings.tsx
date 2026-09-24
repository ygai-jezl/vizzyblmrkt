"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/admin/email/Modal";
import { api, errorText, type PublicConnection } from "./api";
import { KeyReveal } from "./KeyReveal";
import { Banner, Button, Field, Section, inputClass } from "./ui";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";
import { isInvitesUiEnabled } from "@/lib/invites/flags";

const PHASE3 = isNavV2Phase3Enabled();
const INVITES = isInvitesUiEnabled();

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
  const [environment, setEnvironment] = useState(connection.environment ?? "");
  const [ctxUrl, setCtxUrl] = useState(connection.contextEndpoint?.url ?? "");
  const [ctxOn, setCtxOn] = useState(connection.contextEndpoint?.enabled ?? false);
  const [timeoutMs, setTimeoutMs] = useState(connection.contextEndpoint?.timeoutMs ?? 5000);
  const [hookUrl, setHookUrl] = useState(connection.webhookEndpoint?.url ?? "");
  const [hookOn, setHookOn] = useState(connection.webhookEndpoint?.enabled ?? false);
  const [domains, setDomains] = useState(connection.linkDomains.join(", "));
  const [signupUrl, setSignupUrl] = useState(connection.signupUrl ?? "");
  /** Set when the sign-up link's domain isn't allowed yet: offer to add it. */
  const [missingDomain, setMissingDomain] = useState<string | null>(null);
  const [verifyCorp, setVerifyCorp] = useState(connection.consentPolicy.verifyCorporateDomain);
  const [bases, setBases] = useState<string[]>(connection.consentPolicy.marketingBases);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [hookMsg, setHookMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const disabled = !canEdit || connection.status === "revoked";
  const hookSaved = Boolean(connection.webhookEndpoint?.enabled && connection.webhookEndpoint.url);

  /** Send one signed connection.test to the SAVED webhook URL and say what came back. */
  async function testWebhook() {
    setHookMsg(null);
    const r = await api<{ ok: boolean; status?: number; error?: string }>(`/api/admin/connections/${connection.id}/test-webhook`, { method: "POST" });
    if (r.ok && r.data.ok) return setHookMsg({ tone: "ok", text: `Delivered — your endpoint replied ${r.data.status ?? 200}.` });
    const err = r.data?.error ?? "";
    const text = err.startsWith("http_")
      ? `Your endpoint replied ${err.slice(5)} — it should verify the request and reply 2xx.`
      : err === "not_configured"
        ? "Save a webhook URL with Enabled ticked first."
        : errorText(r.data);
    setHookMsg({ tone: "err", text });
  }

  async function patch(body: Record<string, unknown>, okText: string) {
    setBusy(true);
    setMsg(null);
    setMissingDomain(null);
    const r = await api<{ error?: string; detail?: string }>(`/api/admin/connections/${connection.id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!r.ok) {
      if (r.data.error === "signup_url_domain_not_allowed" && r.data.detail) setMissingDomain(r.data.detail);
      return setMsg({ tone: "err", text: errorText(r.data) });
    }
    setMsg({ tone: "ok", text: okText });
    onSaved();
  }

  function save(extraDomain?: string) {
    const list = domains.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean);
    if (extraDomain && !list.includes(extraDomain)) {
      list.push(extraDomain);
      setDomains(list.join(", "));
    }
    const body: Record<string, unknown> = {
      name,
      ...(PHASE3 && !sandbox ? { environment: environment || null } : {}),
      linkDomains: list,
      ...(INVITES && !sandbox ? { signupUrl: signupUrl.trim() || null } : {}),
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
        {PHASE3 && !sandbox ? (
          <Field label="Environment" hint="Staging and production copies of the same product are shown together on Products.">
            <select
              className={inputClass}
              disabled={disabled}
              value={environment}
              onChange={(e) => setEnvironment(e.target.value as "staging" | "production" | "")}
            >
              <option value="">Not set</option>
              <option value="staging">Staging</option>
              <option value="production">Production</option>
            </select>
          </Field>
        ) : null}
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
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" disabled={disabled || sandbox} checked={hookOn} onChange={(e) => setHookOn(e.target.checked)} /> Enabled
          </label>
          {!sandbox && !disabled && hookSaved ? <Button onClick={() => void testWebhook()}>Test webhook</Button> : null}
          <a className="text-xs text-neutral-500 underline" href="/developers/webhooks" target="_blank" rel="noreferrer">What to build</a>
        </div>
        {hookMsg ? <Banner tone={hookMsg.tone}>{hookMsg.text}</Banner> : null}
        <Field label="Allowed link domains" hint="Step links your product returns must be https on one of these domains; others are dropped.">
          <input className={inputClass} disabled={disabled} value={domains} placeholder="yourproduct.com" onChange={(e) => setDomains(e.target.value)} />
        </Field>
        {INVITES && !sandbox ? (
          <Field
            label="Sign-up link"
            hint="Where invited waitlist members sign up. Invite links send people here with yg_invite=… added. It must be https on one of the allowed link domains."
          >
            <input
              className={inputClass}
              disabled={disabled}
              value={signupUrl}
              placeholder="https://app.yourproduct.com/signup"
              onChange={(e) => setSignupUrl(e.target.value)}
            />
          </Field>
        ) : null}
        {missingDomain && !disabled ? (
          <Banner tone="info">
            {missingDomain} isn&apos;t an allowed link domain yet.{" "}
            <Button onClick={() => save(missingDomain)} disabled={busy}>
              Add {missingDomain} and save
            </Button>
          </Banner>
        ) : null}
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
          <Button tone="primary" disabled={busy} onClick={() => save()}>
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
