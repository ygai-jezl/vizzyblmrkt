"use client";

import { useState } from "react";
import { api, errorText, type PublicConnection } from "./api";
import { Badge, Banner, Button, Field, JsonBlock, inputClass } from "./ui";

interface ContextOk {
  ok: true;
  latencyMs: number;
  warnings: string[];
  context: {
    asOf: string;
    steps: Array<{ id: string; label: string; done: boolean; url?: string | null }>;
    nextStep?: { id: string; label: string; url?: string | null } | null;
    facts: Array<{ id: string; label: string; value: string | number | boolean; unit?: string | null }>;
    insights: Array<{ id: string; sentence: string; weight: number }>;
  };
}
interface ContextFail {
  ok: false;
  latencyMs: number;
  error: string;
  detail?: string;
}

const HELP: Record<string, string> = {
  not_configured: "No context endpoint is set up (or it's disabled) — add one in Settings.",
  blocked_url: "The endpoint URL isn't allowed: it must be public https on port 443, with no redirects.",
  timeout: "Your endpoint didn't answer within the timeout.",
  too_large: "The response was over 64 KB.",
  bad_json: "The response wasn't JSON.",
  bad_schema: "The response didn't match the context schema.",
};

/** "Test connection": pull context for one user and show the validated payload. */
export function ContextTester({ connection, canEdit }: { connection: PublicConnection; canEdit: boolean }) {
  const [userId, setUserId] = useState(connection.sandbox?.users[0]?.userId ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ContextOk | ContextFail | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    const r = await api<ContextOk | ContextFail>(`/api/admin/connections/${connection.id}/test-context`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    });
    setBusy(false);
    if (!r.ok) return setError(errorText(r.data));
    setResult(r.data);
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Before each email the platform asks your product for this user&apos;s onboarding steps,
        facts and insight sentences. Try it for one user.
      </p>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Field label="User id (your product's id for the user)">
            <input className={inputClass} value={userId} onChange={(e) => setUserId(e.target.value)} />
          </Field>
        </div>
        <Button tone="primary" disabled={busy || !userId.trim() || !canEdit} onClick={run}>
          {busy ? "Asking…" : "Test connection"}
        </Button>
      </div>
      {error ? <Banner tone="err">{error}</Banner> : null}

      {result && !result.ok ? (
        <Banner tone="err">
          {HELP[result.error] ?? `Your endpoint answered ${result.error.replace("http_", "HTTP ")}.`}
          {result.detail ? ` (${result.detail})` : ""} · {result.latencyMs} ms
        </Banner>
      ) : null}

      {result?.ok ? (
        <div className="space-y-3">
          <Banner tone="ok">Valid context in {result.latencyMs} ms.</Banner>
          {result.warnings.length > 0 ? (
            <Banner tone="info">
              Links outside your allowed link domains were removed: {result.warnings.join(", ")}
            </Banner>
          ) : null}
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <h4 className="text-xs font-semibold">Onboarding</h4>
              <ul className="space-y-0.5 text-sm">
                {result.context.steps.map((s) => (
                  <li key={s.id}>
                    {s.done ? "✓" : "☐"} {s.label}{" "}
                    {result.context.nextStep?.id === s.id ? <Badge tone="amber">next</Badge> : null}
                  </li>
                ))}
              </ul>
            </div>
            <div className="space-y-1">
              <h4 className="text-xs font-semibold">Facts</h4>
              <ul className="space-y-0.5 text-sm">
                {result.context.facts.map((f) => (
                  <li key={f.id}>
                    {f.label}: <strong>{String(f.value)}{f.unit ?? ""}</strong>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="space-y-1">
            <h4 className="text-xs font-semibold">Insight candidates</h4>
            <ul className="list-disc space-y-0.5 pl-5 text-sm">
              {result.context.insights.map((i) => (
                <li key={i.id}>{i.sentence}</li>
              ))}
            </ul>
          </div>
          <details>
            <summary className="cursor-pointer text-xs text-neutral-500">Raw payload</summary>
            <JsonBlock value={result.context} />
          </details>
        </div>
      ) : null}
    </div>
  );
}
