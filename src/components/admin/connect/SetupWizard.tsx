"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/admin/email/Modal";
import { api, errorText, type PublicConnection } from "./api";
import { KeyReveal } from "./KeyReveal";
import { EventDebugger } from "./EventDebugger";
import { Banner, Button, Field, inputClass } from "./ui";

type Step = "name" | "keys" | "install" | "listen";

/**
 * Connect a product, or create a Sandbox, in a few steps:
 *   name → keys (shown once) → install snippet → wait for the first event.
 * A sandbox skips install/listen: it can fire its own events.
 */
export function SetupWizard({
  open,
  kind,
  onClose,
  onCreated,
}: {
  open: boolean;
  kind: "custom" | "sandbox";
  onClose: () => void;
  onCreated: () => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ connection: PublicConnection; secret: string } | null>(null);
  const [stored, setStored] = useState(false);

  useEffect(() => {
    if (open) {
      setStep("name");
      setName(kind === "sandbox" ? "Sandbox" : "");
      setError(null);
      setCreated(null);
      setStored(false);
    }
  }, [open, kind]);

  async function create() {
    setBusy(true);
    setError(null);
    const r = await api<{ connection: PublicConnection; secret: string }>("/api/admin/connections", {
      method: "POST",
      body: JSON.stringify({ name, kind }),
    });
    setBusy(false);
    if (!r.ok) return setError(errorText(r.data));
    setCreated(r.data);
    setStep("keys");
    onCreated();
  }

  function finish() {
    if (created) router.push(`/admin/products/${created.connection.id}`);
    onClose();
  }

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const title = kind === "sandbox" ? "Create a sandbox" : "Connect a product";

  return (
    <Modal open={open} onClose={onClose} title={title} wide={step === "install" || step === "listen"}>
      <div className="space-y-4">
        {error ? <Banner tone="err">{error}</Banner> : null}

        {step === "name" ? (
          <>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              {kind === "sandbox"
                ? "A sandbox is a pretend product with a test user (you). Use it to see onboarding journeys work before writing any integration code."
                : "Your product will send us events (sign-ups, onboarding steps) and answer a signed context request before each email."}
            </p>
            <Field label="Name">
              <input
                className={inputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. vizzybl.ai"
                maxLength={120}
                autoFocus
              />
            </Field>
            <div className="flex justify-end">
              <Button tone="primary" disabled={busy || !name.trim()} onClick={create}>
                {busy ? "Creating…" : "Create"}
              </Button>
            </div>
          </>
        ) : null}

        {step === "keys" && created ? (
          <>
            <KeyReveal keyId={created.connection.keyId} secret={created.secret} />
            {kind === "custom" ? (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={stored} onChange={(e) => setStored(e.target.checked)} />
                I&apos;ve stored the secret somewhere safe
              </label>
            ) : null}
            <div className="flex justify-end gap-2">
              {kind === "sandbox" ? (
                <Button tone="primary" onClick={finish}>
                  Open the sandbox
                </Button>
              ) : (
                <Button tone="primary" disabled={!stored} onClick={() => setStep("install")}>
                  Next: install
                </Button>
              )}
            </div>
          </>
        ) : null}

        {step === "install" && created ? (
          <>
            <InstallSnippet origin={origin} keyId={created.connection.keyId} />
            <div className="flex justify-end">
              <Button tone="primary" onClick={() => setStep("listen")}>
                Next: send your first event
              </Button>
            </div>
          </>
        ) : null}

        {step === "listen" && created ? (
          <>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Send an identify or track event from your product. It appears here within a few
              seconds — rejected messages show their reason.
            </p>
            <EventDebugger connectionId={created.connection.id} compact />
            <div className="flex justify-end">
              <Button tone="primary" onClick={finish}>
                Done
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  );
}

/** How to send events without the SDK: sign the raw body with HMAC-SHA256. */
function InstallSnippet({ origin, keyId }: { origin: string; keyId: string }) {
  const snippet = `// Node 18+ — send events to ${origin}/api/v1/events
import { createHmac, randomUUID } from "node:crypto";

const KEY_ID = "${keyId}";
const SECRET = process.env.YOUGROW_SECRET; // the secret you just copied

export async function sendEvents(batch) {
  const body = JSON.stringify({ batch });
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", SECRET).update(\`events:\${ts}.\${body}\`).digest("hex");
  const res = await fetch("${origin}/api/v1/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-yougrow-key-id": KEY_ID,
      "x-yougrow-timestamp": String(ts),
      "x-yougrow-signature": \`v1=\${sig}\`,
    },
    body,
  });
  return res.json(); // { accepted, duplicates, rejected: [...] }
}

// On sign-up:
await sendEvents([
  { type: "identify", messageId: randomUUID(), userId: user.id,
    timestamp: new Date().toISOString(),
    traits: { email: user.email, firstName: user.firstName, timezone: "Europe/London" },
    consent: { basis: "soft_opt_in" } },
  { type: "track", messageId: randomUUID(), userId: user.id,
    timestamp: new Date().toISOString(), event: "user.signed_up" },
]);

// When an onboarding step is done:
await sendEvents([{ type: "track", messageId: randomUUID(), userId: user.id,
  timestamp: new Date().toISOString(), event: "onboarding.step_completed",
  properties: { step: "create_brand" } }]);`;
  return (
    <div className="space-y-2">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Call this from your server (never the browser). Every message needs a unique{" "}
        <code className="font-mono text-xs">messageId</code> — resending one is harmless. Up to 100
        messages per request; timestamps must include a timezone.
      </p>
      <pre className="max-h-96 overflow-auto rounded-md border border-neutral-200 bg-neutral-50 p-3 font-mono text-xs dark:border-neutral-800 dark:bg-neutral-900">
        {snippet}
      </pre>
    </div>
  );
}
