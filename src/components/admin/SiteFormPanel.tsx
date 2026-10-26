"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { KeyReveal } from "./connect/KeyReveal";
import { Banner, Button, Field, Section, inputClass } from "./connect/ui";

/**
 * "Your own form" on a launch's Page & widget tab (LAUNCH_SITE_SIGNUPS_ENABLED): the
 * launch's site key, where people land after confirming, and the call the brand's
 * server makes. The secret shows once, after Create site key or Rotate secret.
 */

interface KeyView {
  keyId: string;
  secretPrefix: string;
  rotating: boolean;
  lastUsedAt: string | null;
  weekSignups: number;
  siteConfirmedUrl: string | null;
}

type Load =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; key: KeyView | null; endpoint: string; canCreate: boolean };

function whenText(iso: string | null): string {
  if (!iso) return "Not used yet";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 15) return "In the last 15 minutes";
  if (mins < 120) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hours ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function curlExample(endpoint: string): string {
  return [
    `curl ${endpoint} \\`,
    `  -u "$YOUGROW_KEY_ID:$YOUGROW_SECRET" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"email":"sam@example.com","locale":"en-GB","source":"blog/first-post"}'`,
  ].join("\n");
}

export function SiteFormPanel({ campaignId, canEdit }: { campaignId: string; canEdit: boolean }) {
  const api = `/api/admin/campaigns/${encodeURIComponent(campaignId)}/site-key`;
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [reveal, setReveal] = useState<{ keyId: string; secret: string } | null>(null);
  const [stored, setStored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [thanks, setThanks] = useState("");
  const [thanksStatus, setThanksStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [copied, setCopied] = useState(false);

  async function refresh() {
    const res = await fetch(api, { cache: "no-store" }).catch(() => null);
    if (!res?.ok) return setLoad({ state: "error" });
    const body = (await res.json()) as { key: KeyView | null; endpoint: string; canCreate: boolean };
    setLoad({ state: "ready", ...body });
    setThanks(body.key?.siteConfirmedUrl ?? "");
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  async function call(method: string, url: string, body?: unknown): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setProblem(
          json.error === "encryption_unavailable"
            ? "Keys can't be made on this YouGrow yet. Whoever runs it needs to set CONNECT_SECRET_ENC_KEY."
            : json.error === "key_exists"
              ? "This launch already has a key. Refresh the page to see it."
              : typeof json.message === "string"
                ? json.message
                : "That didn't work. Please try again.",
        );
        return null;
      }
      return json;
    } catch {
      setProblem("That didn't work. Check your connection and try again.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    const r = await call("POST", api);
    if (r?.secret && r.key) {
      setReveal({ keyId: (r.key as KeyView).keyId, secret: r.secret as string });
      setStored(false);
    }
  }

  async function rotate() {
    const r = await call("POST", `${api}/rotate`);
    if (r?.secret && r.key) {
      setReveal({ keyId: (r.key as KeyView).keyId, secret: r.secret as string });
      setStored(false);
    }
  }

  async function revoke() {
    if (await call("DELETE", api)) {
      setConfirmRevoke(false);
      await refresh();
    }
  }

  async function saveThanks() {
    setThanksStatus("saving");
    const r = await call("PATCH", api, { siteConfirmedUrl: thanks.trim() });
    setThanksStatus(r ? "saved" : "idle");
    if (r) await refresh();
  }

  if (load.state === "loading") return <p className="text-sm text-neutral-500">Loading…</p>;
  if (load.state === "error") return <Banner tone="err">The site key couldn&apos;t be loaded. Refresh the page to try again.</Banner>;

  const { key, endpoint, canCreate } = load;
  const example = curlExample(endpoint);

  return (
    <div className="space-y-4">
      {problem ? <Banner tone="err">{problem}</Banner> : null}

      <Section title="Site key" description="It can only add sign-ups to this launch. It can't read anyone.">
        {reveal ? (
          <div className="space-y-3">
            <KeyReveal
              keyId={reveal.keyId}
              secret={reveal.secret}
              note="Copy the secret now and store it in your site's secret manager. It is shown only once. If you lose it, use Rotate secret."
              keyLabel="Key id: the username"
              secretLabel="Secret: the password, keep it on your server"
            />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={stored} onChange={(e) => setStored(e.target.checked)} className="h-4 w-4 rounded border-neutral-300" />
              I&apos;ve stored the secret somewhere safe
            </label>
            <Button
              tone="primary"
              disabled={!stored}
              onClick={async () => {
                setReveal(null);
                await refresh();
              }}
            >
              Done
            </Button>
          </div>
        ) : key ? (
          <div className="space-y-3">
            <p className="text-sm text-neutral-600 dark:text-neutral-300">
              Key id <code className="font-mono text-xs">{key.keyId}</code> · secret <code className="font-mono text-xs">{key.secretPrefix}…</code>
            </p>
            <p className="text-sm text-neutral-600 dark:text-neutral-300">Last used: {whenText(key.lastUsedAt)}</p>
            <p className="text-sm text-neutral-600 dark:text-neutral-300">
              {key.weekSignups === 1 ? "1 sign-up" : `${key.weekSignups} sign-ups`} from your site this week
            </p>
            {key.rotating ? <p className="text-xs text-neutral-500">The previous secret still works until 24 hours after you rotated it.</p> : null}
            {canEdit ? (
              confirmRevoke ? (
                <div className="space-y-2 rounded-md border border-red-200 p-3 dark:border-red-900">
                  <p className="text-sm">Revoke this key? Calls with it stop working within a minute, and your site can&apos;t add sign-ups until you make a new key.</p>
                  <div className="flex gap-2">
                    <Button tone="danger" disabled={busy} onClick={revoke}>
                      Revoke key
                    </Button>
                    <Button onClick={() => setConfirmRevoke(false)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button disabled={busy} onClick={rotate}>
                    Rotate secret
                  </Button>
                  <Button tone="danger" disabled={busy} onClick={() => setConfirmRevoke(true)}>
                    Revoke key
                  </Button>
                </div>
              )
            ) : null}
            {canEdit && !confirmRevoke ? <p className="text-xs text-neutral-500">After Rotate secret, the old secret keeps working for 24 hours.</p> : null}
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-neutral-600 dark:text-neutral-300">No site key yet.</p>
            {canEdit ? (
              <Button tone="primary" disabled={busy || !canCreate} onClick={create}>
                Create site key
              </Button>
            ) : (
              <p className="text-xs text-neutral-500">Ask an admin of this brand to create one.</p>
            )}
            {!canCreate ? <p className="text-xs text-neutral-500">Keys can&apos;t be made on this YouGrow yet. Whoever runs it needs to set CONNECT_SECRET_ENC_KEY.</p> : null}
          </div>
        )}
      </Section>

      {key && !reveal ? (
        <Section title="After someone confirms">
          <Field label="Send them to" hint="Leave blank to show a “You're subscribed” page.">
            <input
              id="site-confirmed-url"
              type="url"
              inputMode="url"
              placeholder="https://example.com/thanks"
              value={thanks}
              disabled={!canEdit}
              onChange={(e) => {
                setThanks(e.target.value);
                setThanksStatus("idle");
              }}
              className={inputClass}
            />
          </Field>
          {canEdit ? (
            <div className="flex items-center gap-3">
              <Button disabled={busy || thanks.trim() === (key.siteConfirmedUrl ?? "")} onClick={saveThanks}>
                Save
              </Button>
              {thanksStatus === "saved" ? <span className="text-xs text-neutral-500">Saved.</span> : null}
            </div>
          ) : null}
        </Section>
      ) : null}

      <Section
        title="The call your server makes"
        actions={
          <Button
            onClick={async () => {
              await navigator.clipboard?.writeText(example).catch(() => {});
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "Copied" : "Copy"}
          </Button>
        }
      >
        <pre className="overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-50 p-3 font-mono text-xs dark:border-neutral-800 dark:bg-neutral-900">{example}</pre>
        <p className="text-xs text-neutral-500">
          Server to server only. Never put the secret in your page. Show visitors the same “Check your inbox” message whatever the reply.{" "}
          <a href="/help/newsletter-from-your-site" className="underline">
            How it works
          </a>
        </p>
      </Section>
    </div>
  );
}
