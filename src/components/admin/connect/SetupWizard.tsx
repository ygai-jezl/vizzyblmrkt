"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/admin/email/Modal";
import { api, errorText, type PublicConnection } from "./api";
import { KeyReveal } from "./KeyReveal";
import { EventDebugger } from "./EventDebugger";
import { Banner, Button, Field, inputClass } from "./ui";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";

const PHASE3 = isNavV2Phase3Enabled();

type Step = "name" | "keys" | "learn" | "install" | "listen";

/**
 * Connect a product, or create a Sandbox, in a few steps:
 *   name → keys (shown once) → learn from your repo (recommended) → install snippet → wait for the first event.
 * A sandbox skips install/listen: it can fire its own events.
 */
export function SetupWizard({
  open,
  kind,
  preset = null,
  onClose,
  onCreated,
}: {
  open: boolean;
  kind: "custom" | "sandbox";
  /** Connecting another environment of an existing product (nav v2 phase 3). */
  preset?: { name: string; environment: "staging" | "production" } | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState("");
  const [environment, setEnvironment] = useState<"staging" | "production" | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ connection: PublicConnection; secret: string } | null>(null);
  const [stored, setStored] = useState(false);

  useEffect(() => {
    if (open) {
      setStep("name");
      setName(kind === "sandbox" ? "Sandbox" : (preset?.name ?? ""));
      setEnvironment(preset?.environment ?? "");
      setError(null);
      setCreated(null);
      setStored(false);
    }
  }, [open, kind, preset]);

  async function create() {
    setBusy(true);
    setError(null);
    const r = await api<{ connection: PublicConnection; secret: string }>("/api/admin/connections", {
      method: "POST",
      body: JSON.stringify(
        PHASE3 && kind === "custom" ? { name, kind, environment: environment || null } : { name, kind },
      ),
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
            {PHASE3 && kind === "custom" ? (
              <Field
                label="Which copy of your product is this?"
                hint="Connect staging first to test journeys safely, then production — journeys move across with “Promote to Production”."
              >
                <select
                  className={inputClass}
                  value={environment}
                  onChange={(e) => setEnvironment(e.target.value as "staging" | "production" | "")}
                >
                  <option value="">Not sure yet</option>
                  <option value="staging">Staging</option>
                  <option value="production">Production</option>
                </select>
              </Field>
            ) : null}
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
                <Button tone="primary" disabled={!stored} onClick={() => setStep("learn")}>
                  Next
                </Button>
              )}
            </div>
          </>
        ) : null}

        {step === "learn" && created ? (
          <>
            <div className="space-y-2 text-sm">
              <p className="font-medium">Recommended: let YouGrow learn your product from its code</p>
              <p className="text-neutral-600 dark:text-neutral-400">
                Connect GitHub (read-only — about a minute) and we&apos;ll propose your onboarding steps and how each is
                done, the events to send and the facts you can report, with the code each came from. You review what we
                keep, and your Integration guide then lists exactly what to build.
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button onClick={() => setStep("install")}>Skip — show the install snippet</Button>
              <Button tone="primary" onClick={() => router.push(`/admin/products/${created.connection.id}?tab=learn`)}>
                Learn from my repo
              </Button>
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
              Send a user&apos;s state from your product. It appears here within a few seconds —
              rejected writes show their reason.
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

/** How to send a user's state without the SDK: one PATCH, HTTP Basic auth (API v2). */
function InstallSnippet({ origin, keyId }: { origin: string; keyId: string }) {
  const snippet = `// Node 18+ — send a user's state to ${origin}/api/v2/users/{userId}
const KEY_ID = "${keyId}";
const SECRET = process.env.YOUGROW_SECRET; // the secret you just copied
const AUTH = "Basic " + Buffer.from(\`\${KEY_ID}:\${SECRET}\`).toString("base64");

export async function updateUser(userId, state) {
  const res = await fetch(\`${origin}/api/v2/users/\${encodeURIComponent(userId)}\`, {
    method: "PATCH",
    headers: { authorization: AUTH, "content-type": "application/json" },
    body: JSON.stringify(state),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(\`YouGrow \${res.status}: \${await res.text()}\`);
  return res.json(); // { applied, user }
}

// On sign-up:
await updateUser(user.id, {
  email: user.email,
  firstName: user.firstName,
  timezone: "Europe/London",
  consent: "soft_opt_in",
  signedUpAt: new Date().toISOString(),
});

// When an onboarding step is done (send the same fields again any time — it's a merge):
await updateUser(user.id, { steps: { create_brand: new Date().toISOString() } });`;
  return (
    <div className="space-y-2">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Call this from your server (never the browser). Each call sends a user&apos;s current state:
        fields you send replace ours, fields you leave out stay, and resending is harmless. Timestamps
        must include a timezone.
      </p>
      <pre className="max-h-96 overflow-auto rounded-md border border-neutral-200 bg-neutral-50 p-3 font-mono text-xs dark:border-neutral-800 dark:bg-neutral-900">
        {snippet}
      </pre>
    </div>
  );
}
